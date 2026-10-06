/**
 * Regression test for #2661: Auto-mode dispatches deferred slices.
 *
 * A deferred slice is skipped by the dispatcher, and decision text alone
 * never changes slice status:
 *   1. deriveStateFromDb skips slices with status "deferred"
 *   2. saveDecisionToDb leaves slice status unchanged for deferral prose
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  openDatabase,
  closeDatabase,
  getSlice,
  isDbAvailable,
  insertMilestone,
  insertSlice,
  insertTask,
  insertArtifact,
  updateSliceStatus,
} from "../gsd-db.ts";
import { isDeferredStatus } from "../status-guards.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-deferred-dispatch-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function adoptSlice(milestoneId: string, sliceId: string): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.adopt",
    idempotencyKey: `deferred-slice/${milestoneId}/${sliceId}/adopt`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId, sliceId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId,
      sliceId,
      lifecycleStatus: "in_progress",
    });
    return {
      events: [{
        eventType: "test.slice.adopted",
        entityType: "slice",
        entityId: `${milestoneId}/${sliceId}`,
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${milestoneId}/${sliceId}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("deferred-slice-dispatch (#2661)", () => {
  test("isDeferredStatus returns true for 'deferred'", () => {
    assert.ok(isDeferredStatus("deferred"), "should recognize 'deferred'");
    assert.ok(!isDeferredStatus("active"), "should not match 'active'");
    assert.ok(!isDeferredStatus("complete"), "should not match 'complete'");
    assert.ok(!isDeferredStatus("pending"), "should not match 'pending'");
  });

  test("deriveStateFromDb skips deferred slice and picks next eligible", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");
      assert.ok(isDbAvailable());

      // M001 with three slices: S01 complete, S02 deferred, S03 pending
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });

      insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Deferred Slice", status: "deferred", risk: "low", depends: [] });
      insertSlice({ id: "S03", milestoneId: "M001", title: "Next Slice", status: "pending", risk: "low", depends: [] });

      // S01 needs a SUMMARY file to count as complete for milestone-level checks
      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001: Test Milestone

**Vision:** Test deferred slices.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > Done.

- [ ] **S02: Deferred Slice** \`risk:low\` \`depends:[]\`
  > Deferred.

- [ ] **S03: Next Slice** \`risk:low\` \`depends:[]\`
  > Next.
`);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", "# S01 Summary\nDone.");

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // The active slice must be S03, NOT S02 (which is deferred)
      assert.equal(state.activeMilestone?.id, "M001", "active milestone is M001");
      assert.equal(state.activeSlice?.id, "S03", "active slice should skip deferred S02 and land on S03");
      assert.notEqual(state.activeSlice?.id, "S02", "active slice must NOT be the deferred S02");

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test("deriveStateFromDb counts a deferred slice as needing no further work", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");

      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Complete", status: "complete", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Deferred", status: "deferred", risk: "low", depends: [] });
      insertSlice({ id: "S03", milestoneId: "M001", title: "Pending", status: "pending", risk: "low", depends: [] });

      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001
## Slices
- [x] **S01: Complete** \`risk:low\` \`depends:[]\`
- [ ] **S02: Deferred** \`risk:low\` \`depends:[]\`
- [ ] **S03: Pending** \`risk:low\` \`depends:[]\`
`);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", "# Done");

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // Deferred is terminal in the read model: S01 (complete) and S02
      // (deferred) need no further work, so only S03 remains.
      assert.equal(state.progress?.slices?.done, 2, "S01 and deferred S02 need no further work");
      assert.equal(state.activeSlice?.id, "S03", "S03 is the remaining slice");
      // Total should still be 3 (deferred slices are still part of the milestone)
      assert.equal(state.progress?.slices?.total, 3, "all 3 slices counted in total");

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test("all slices deferred does not block milestone closeout", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");

      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Deferred A", status: "deferred", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Deferred B", status: "deferred", risk: "low", depends: [] });

      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001
## Slices
- [ ] **S01: Deferred A** \`risk:low\` \`depends:[]\`
- [ ] **S02: Deferred B** \`risk:low\` \`depends:[]\`
`);

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // No slice is left to run, and deferred slices do not block closeout:
      // the milestone moves on to its closeout phases instead of stalling.
      assert.equal(state.activeSlice, null, "no active slice when all deferred");
      assert.equal(state.activeMilestone?.id, "M001");
      assert.notEqual(state.phase, "blocked", "deferred slices must not block the milestone");
      assert.deepEqual(state.blockers, [], "no dependency blocker is reported");

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  // Decision prose is narrative only: a slice leaves the run only through its
  // own cancellation Domain Operation (gsd_skip_slice), never by regex on text.
  for (const adopted of [false, true]) {
    test(`decision text 'defer M001/S03' saves the decision and leaves the ${adopted ? "adopted" : "legacy"} slice status unchanged`, async (t) => {
      const base = createFixtureBase();
      t.after(() => {
        closeDatabase();
        cleanup(base);
      });
      openDatabase(":memory:");
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S03", milestoneId: "M001", title: "Target Slice", status: "active", risk: "low", depends: [] });
      if (adopted) adoptSlice("M001", "S03");

      const { saveDecisionToDb } = await import("../db-writer.ts");
      await saveDecisionToDb(
        {
          scope: "deferral",
          decision: "M001/S03 is deferred",
          choice: "defer M001/S03",
          rationale: "Not ready yet",
        },
        base,
      );

      assert.equal(getSlice("M001", "S03")?.status, "active");
      assert.equal(_getAdapter()?.prepare("SELECT COUNT(*) AS count FROM memories").get()?.["count"], 1);
    });
  }
});
