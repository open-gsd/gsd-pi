// Project/App: gsd-pi
// File Purpose: Pure diagnostic preview coverage without opening a workflow database.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LifecycleBackfillPreview } from "../lifecycle-backfill-domain-operation.js";
import { formatLifecycleBackfillPreview } from "../lifecycle-backfill-preview.js";

function emptyPreview(): LifecycleBackfillPreview {
  return { items: [], waiverRepairs: [], unmarkedImportCompletions: [], unknownStatuses: [], openUnderCompletedParent: [] };
}

function item(index: number, itemKind: "task" | "slice" | "milestone"): LifecycleBackfillPreview["items"][number] {
  return {
    itemKind, milestoneId: `M${index}`, sliceId: itemKind === "milestone" ? null : `S${index}`,
    taskId: itemKind === "task" ? `T${index}` : null,
    rawStatus: "complete", completedAt: "2020-01-01T00:00:00Z", lifecycleStatus: "ready",
    rule: "legacy-complete-unproven", projectedLegacyStatus: itemKind === "milestone" ? "active" : "pending",
  };
}

test("enumerates all 63 status changes and separates 86 initial adoptions from existing repairs", () => {
  const preview = emptyPreview();
  for (let index = 0; index < 86; index++) {
    const row = item(index, index < 30 ? "task" : index < 53 ? "slice" : "milestone");
    if (index >= 63) {
      row.projectedLegacyStatus = null;
      row.lifecycleStatus = index < 83 ? "completed" : "cancelled";
      row.rule = index < 83 ? "legacy-complete-evidenced" : "legacy-cancelled";
    }
    preview.items.push(row);
  }
  const before = structuredClone(preview);
  const output = formatLifecycleBackfillPreview(preview);
  assert.match(output, /Initial adoptions: 86; projected status changes: 63/);
  assert.match(output, /Initial effects: 3 cancelled-item Waivers; 20 unverified-legacy adoption markers/);
  assert.match(output, /Existing-row repairs: 0 Waivers; 0 imported-completion markers/);
  assert.match(output, /legacy-complete-unproven: 63/);
  assert.match(output, /legacy-complete-evidenced: 20/);
  assert.match(output, /legacy-cancelled: 3/);
  for (const row of preview.items) {
    const identity = JSON.stringify([row.milestoneId, row.sliceId, row.taskId].filter((part) => part !== null).join("/"));
    const planning = row.projectedLegacyStatus === null
      ? '"complete" (unchanged)'
      : `"complete" -> ${JSON.stringify(row.projectedLegacyStatus)}`;
    assert.ok(output.includes(`${row.itemKind} ${identity}: ${planning}; canonical=${row.lifecycleStatus}; rule=${row.rule}`));
  }
  assert.equal(output.split(" -> ").length - 1, 63);
  assert.equal(output.match(/"complete" -> "active"/g)?.length, 10);
  assert.equal(output.match(/"complete" -> "pending"/g)?.length, 53);
  assert.equal(output.match(/effects=Waiver/g)?.length, 3);
  assert.equal(output.match(/effects=unverified-legacy/g)?.length, 20);
  assert.match(output, /not host Technical Verdicts/);
  assert.match(output, /completion timestamps/);
  assert.match(output, /queue/);
  assert.doesNotMatch(output, /host (?:verification|success) (?:passed|confirmed)/i);
  assert.deepEqual(preview, before);
});

test("reports repair-only counts separately from initial effects", () => {
  const preview = emptyPreview();
  preview.waiverRepairs.push({
    itemKind: "task", milestoneId: "M1", sliceId: "S1", taskId: "T1",
    lifecycleId: "life-1", rawStatus: "cancelled", completedAt: null,
  });
  preview.unmarkedImportCompletions.push({
    itemKind: "slice", milestoneId: "M2", sliceId: "S2", taskId: null,
    lifecycleId: "life-2", rawStatus: "complete", completedAt: "2020-01-01T00:00:00Z",
  });
  const output = formatLifecycleBackfillPreview(preview);
  assert.match(output, /Initial adoptions: 0; projected status changes: 0/);
  assert.match(output, /Initial effects: 0 cancelled-item Waivers; 0 unverified-legacy adoption markers/);
  assert.match(output, /Existing-row repairs: 1 Waivers; 1 imported-completion markers/);
  assert.match(output, /adopted-cancelled-without-waiver: 1/);
  assert.match(output, /import-adopted-completion: 1/);
  assert.ok(output.includes('Waiver repair: task "M1/S1/T1"'));
  assert.ok(output.includes('Legacy-marker repair: slice "M2/S2"'));
});

test("empty and unchanged previews do not invent status changes; parent markers and warnings remain visible", () => {
  assert.match(formatLifecycleBackfillPreview(emptyPreview()), /Projected status changes: none/);
  const preview = emptyPreview();
  const row = item(1, "task");
  row.rule = "legacy-complete-under-completed-parent";
  row.lifecycleStatus = "completed";
  row.projectedLegacyStatus = null;
  preview.items.push(row);
  const unchanged = formatLifecycleBackfillPreview(preview);
  assert.match(unchanged, /Initial effects: 0 cancelled-item Waivers; 1 unverified-legacy adoption markers/);
  assert.match(unchanged, /Projected status changes: none/);
  const cancelled = item(2, "slice");
  cancelled.rawStatus = "pending";
  cancelled.lifecycleStatus = "cancelled";
  cancelled.rule = "cancelled-under-completed-parent";
  cancelled.projectedLegacyStatus = "cancelled";
  preview.items.push(cancelled);
  preview.openUnderCompletedParent.push({ row: "slice M2/S2", rawStatus: "pending" });
  const output = formatLifecycleBackfillPreview(preview);
  assert.match(output, /Initial effects: 1 cancelled-item Waivers; 1 unverified-legacy adoption markers/);
  assert.match(output, /Open work under a completed parent, adopted as cancelled/);
  assert.match(output, /slice M2\/S2/);
});

test("quotes data values so raw statuses cannot masquerade as extra preview rows", () => {
  const preview = emptyPreview();
  const row = item(7, "task");
  row.rawStatus = "complete\n";
  row.milestoneId = 'M"7';
  preview.items.push(row);
  const output = formatLifecycleBackfillPreview(preview);
  assert.ok(output.includes(`${JSON.stringify(row.rawStatus)} -> "pending"`));
  assert.ok(output.includes(JSON.stringify('M"7/S7/T7')));
  assert.ok(!output.includes("complete\n"));
});

test("quotes completed-parent warning identities instead of rendering forged diagnostic lines", () => {
  const preview = emptyPreview();
  const row = item(2, "slice");
  row.sliceId = "S2\nforged diagnostic row";
  row.rawStatus = "pending";
  row.lifecycleStatus = "cancelled";
  row.rule = "cancelled-under-completed-parent";
  row.projectedLegacyStatus = "cancelled";
  preview.items.push(row);
  const label = `slice ${row.milestoneId}/${row.sliceId}`;
  preview.openUnderCompletedParent.push({ row: label, rawStatus: row.rawStatus });
  const output = formatLifecycleBackfillPreview(preview);
  assert.ok(output.includes(`${JSON.stringify(label)}: "pending"`));
  assert.ok(!output.includes("\nforged diagnostic row"));
});
