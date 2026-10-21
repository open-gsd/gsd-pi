// Hermetic UNIT tests for the read-only blocker inspection projection. The
// PauseBlockerReader seam is faked, including a legacy row shape without the
// description/requested_action text, to prove fail-soft rendering.
import assert from "node:assert/strict";
import test from "node:test";

import { classifyAutoPauseBlockerResolution, type PauseBlockerReader } from "../pause-blocker-inspection.ts";

const AUTHORITY = { project_id: "p1", revision: 3, authority_epoch: 1 };

// Legacy identity/status columns only, as an older reader surface could
// present them (no description/requested_action usable values).
const LEGACY_BLOCKER_ROW = {
  project_id: "p1", lifecycle_id: "l1", blocker_kind: "consent",
  resolution_owner: "user", blocker_status: "open",
  lifecycle_project_id: "p1", lifecycle_status: "in_progress",
};

function fakeReader(blockerRow: Record<string, unknown>): PauseBlockerReader {
  const rows: Record<string, Record<string, unknown> | undefined> = {
    project_authority: AUTHORITY,
    workflow_blockers: blockerRow,
    // No link/pause rows: inspection refuses with no-associated-pause while
    // still surfacing the blocker identity and its fail-soft context.
  };
  const tableOf = (sql: string): string | undefined =>
    ["project_authority", "workflow_blockers", "auto_pause_blocker_links", "auto_pauses", "runtime_kv"]
      .find((table) => sql.includes(table));
  return {
    prepare(sql: string) {
      return {
        get: () => {
          const table = tableOf(sql);
          return table ? rows[table] : undefined;
        },
        all: () => [],
      };
    },
  };
}

test("inspection surfaces the persisted description and requested action", () => {
  const inspection = classifyAutoPauseBlockerResolution(fakeReader({
    ...LEGACY_BLOCKER_ROW, description: "Approval required", requested_action: "Review",
  }), "b1");
  assert.equal(inspection.eligible, false, "no associated pause is linked in this fixture");
  assert.equal(inspection.failure, "no-associated-pause");
  assert.equal(inspection.blocker?.id, "b1");
  assert.equal(inspection.blocker?.description, "Approval required");
  assert.equal(inspection.blocker?.requestedAction, "Review");
});

test("inspection projects missing legacy context fail-soft as null without throwing", () => {
  const inspection = classifyAutoPauseBlockerResolution(fakeReader({ ...LEGACY_BLOCKER_ROW }), "b-legacy");
  assert.equal(inspection.failure, "no-associated-pause");
  assert.equal(inspection.blocker?.id, "b-legacy");
  assert.equal(inspection.blocker?.description, null);
  assert.equal(inspection.blocker?.requestedAction, null);
});

test("inspection projects non-string legacy context fail-soft as null", () => {
  const inspection = classifyAutoPauseBlockerResolution(fakeReader({
    ...LEGACY_BLOCKER_ROW, description: 42, requested_action: null,
  }), "b-coerced");
  assert.equal(inspection.blocker?.description, null);
  assert.equal(inspection.blocker?.requestedAction, null);
});
