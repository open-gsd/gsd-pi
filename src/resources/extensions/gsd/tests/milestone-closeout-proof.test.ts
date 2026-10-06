// Project/App: gsd-pi
// File Purpose: Tests for the shared milestone closeout proof surface.

import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeDatabase } from "../gsd-db.js";
import { proveMilestoneCloseout } from "../milestone-closeout-proof.js";
import {
  completeValidatedMilestone,
  seedValidatedMilestone,
} from "./helpers/canonical-milestone.ts";

const tmpDirs: string[] = [];

function writeSummary(base: string, status: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
    `---\nstatus: ${status}\n---\n\n# Summary\n`,
    "utf-8",
  );
}

test.after(() => {
  try { closeDatabase(); } catch { /* noop */ }
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proveMilestoneCloseout accepts closed DB state", async () => {
  const fixture = await seedValidatedMilestone("closeout-proof/closed");
  tmpDirs.push(fixture.basePath);
  await completeValidatedMilestone(fixture, "closeout-proof/closed");

  const result = proveMilestoneCloseout(fixture.milestoneId, {
    artifactBasePath: fixture.basePath,
  });

  assert.deepEqual(result, { ok: true });
});

test("proveMilestoneCloseout can prove readiness before DB milestone is closed", async () => {
  const fixture = await seedValidatedMilestone("closeout-proof/ready");
  tmpDirs.push(fixture.basePath);

  const result = proveMilestoneCloseout(fixture.milestoneId, {
    allowOpenMilestone: true,
    artifactBasePath: fixture.basePath,
  });

  assert.deepEqual(result, { ok: true });
});

test("proveMilestoneCloseout takes the outcome from the database, not from the SUMMARY file", async () => {
  const fixture = await seedValidatedMilestone("closeout-proof/db-authoritative");
  tmpDirs.push(fixture.basePath);
  await completeValidatedMilestone(fixture, "closeout-proof/db-authoritative");
  writeSummary(fixture.basePath, "failed");

  const result = proveMilestoneCloseout(fixture.milestoneId, {
    artifactBasePath: fixture.basePath,
  });

  assert.deepEqual(result, { ok: true });
});
