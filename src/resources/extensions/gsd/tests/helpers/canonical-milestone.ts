// Project/App: gsd-pi
// File Purpose: Test helpers that seed a canonical adopted Milestone with a
// recorded passing validation, optionally completed through the real
// milestone.complete Domain Operation.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertMilestone, insertSlice, openDatabase } from "../../gsd-db.ts";
import { seedLifecycles } from "./authority-cutover.ts";
import { handleValidateMilestone } from "../../tools/validate-milestone.ts";
import { handleCompleteMilestone } from "../../tools/complete-milestone.ts";

export interface CanonicalMilestoneFixture {
  basePath: string;
  milestoneId: string;
  sliceId: string;
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Create a temp git repository whose tracked sources never include `.gsd/`. */
export function makeGitProject(prefix: string): string {
  const basePath = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(basePath, ".gitignore"), ".gsd/\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'canonical';\n");
  git(["init"], basePath);
  git(["config", "user.email", "test@example.com"], basePath);
  git(["config", "user.name", "Test"], basePath);
  git(["add", ".gitignore", "source.ts"], basePath);
  git(["commit", "-m", "fixture"], basePath);
  return basePath;
}

/**
 * Seed an adopted open Milestone with one canonically closed slice and a
 * recorded passing canonical validation. The project root is a git repository
 * so the validation receipt binds to the tested source revision.
 */
export async function seedValidatedMilestone(
  key: string,
  options: { milestoneId?: string; sliceId?: string; milestoneStatus?: string } = {},
): Promise<CanonicalMilestoneFixture> {
  const milestoneId = options.milestoneId ?? "M001";
  const sliceId = options.sliceId ?? "S01";
  const basePath = makeGitProject(`gsd-canonical-milestone-`);
  mkdirSync(join(basePath, ".gsd", "milestones", milestoneId, "slices", sliceId), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: milestoneId, title: "Canonical Milestone", status: options.milestoneStatus ?? "active" });
  insertSlice({ id: sliceId, milestoneId, title: "Done", status: "complete" });
  seedLifecycles(key, [
    { itemKind: "milestone", milestoneId, lifecycleStatus: "ready" },
    { itemKind: "slice", milestoneId, sliceId, lifecycleStatus: "completed" },
  ]);
  const validation = await handleValidateMilestone({
    milestoneId,
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "Delivered",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verdictRationale: "Everything passes.",
  }, basePath, {
    invocation: {
      idempotencyKey: `canonical-milestone/${key}/validate`,
      sourceTransport: "internal",
      actorType: "agent",
    },
  });
  assert.ok(!("error" in validation), `canonical validation should record: ${JSON.stringify(validation)}`);
  return { basePath, milestoneId, sliceId };
}

/** Complete a validated Milestone through the real tool (one Domain Operation). */
export async function completeValidatedMilestone(
  fixture: CanonicalMilestoneFixture,
  key: string,
): Promise<void> {
  const completion = await handleCompleteMilestone({
    milestoneId: fixture.milestoneId,
    title: "Canonical Milestone",
    oneLiner: "Done end to end.",
    narrative: "All slices landed and validation passed.",
    verificationPassed: true,
  }, fixture.basePath, {
    idempotencyKey: `canonical-milestone/${key}/complete`,
    sourceTransport: "internal",
    actorType: "agent",
  });
  assert.ok(
    !("error" in completion) && !("pendingCloseoutEffects" in completion),
    `canonical completion should settle: ${JSON.stringify(completion)}`,
  );
}
