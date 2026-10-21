import assert from "node:assert/strict";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearParseCache } from "../files.js";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import { handleCompleteTask } from "../tools/complete-task.js";
import { discardProjectionEvidence } from "./projection-evidence-helpers.js";

const PARAMS = {
  milestoneId: "M001",
  sliceId: "S01",
  taskId: "T01",
  oneLiner: "Publish task completion",
  narrative: "Completed the task and published its projections.",
  verification: "Focused verification passed.",
  deviations: "None.",
  knownIssues: "None.",
  keyFiles: ["src/example.ts"],
  keyDecisions: [],
  blockerDiscovered: false,
  verificationEvidence: [
    { command: "pnpm test focused", exitCode: 0, verdict: "pass", durationMs: 25 },
  ],
};

test("complete-task reports shell projection staleness and same-task repair clears it", async (t) => {
  const basePath = join(tmpdir(), `gsd-complete-task-shell-stale-${process.pid}-${Date.now()}`);
  const sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S01");
  const roadmapPath = join(basePath, ".gsd", "ROADMAP.md");

  t.after(() => {
    clearPathCache();
    clearParseCache();
    try { closeDatabase(); } catch { /* best effort */ }
    rmSync(basePath, { recursive: true, force: true });
  });

  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    "# S01 Plan\n\n## Tasks\n\n- [ ] **T01: Publish task completion**\n",
  );
  openDatabase(join(basePath, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });

  mkdirSync(roadmapPath);
  const completed = await handleCompleteTask(PARAMS, basePath);
  assert.ok(!("error" in completed), `completion failed: ${"error" in completed ? completed.error : ""}`);
  assert.equal(completed.stale, true, "failed shell projection must mark committed completion stale");

  rmSync(completed.summaryPath);
  const staleReplay = await handleCompleteTask(PARAMS, basePath);
  assert.ok(!("error" in staleReplay), `repair replay failed: ${"error" in staleReplay ? staleReplay.error : ""}`);
  assert.equal(staleReplay.duplicate, true, "same-task retry must repair instead of completing twice");
  assert.equal(staleReplay.stale, true, "missing-summary repair must preserve shell projection staleness");

  discardProjectionEvidence(basePath);
  rmSync(roadmapPath, { recursive: true });
  rmSync(staleReplay.summaryPath);
  const repaired = await handleCompleteTask(PARAMS, basePath);
  assert.ok(!("error" in repaired), `second repair replay failed: ${"error" in repaired ? repaired.error : ""}`);
  assert.equal(repaired.duplicate, true, "same-task repair must remain a duplicate completion");
  assert.equal(repaired.stale, undefined, "successful shell projection repair must clear stale");
  assert.equal(statSync(roadmapPath).isFile(), true, "repair must replace the obstruction with ROADMAP.md");

  const evidence = _getAdapter()!.prepare(
    "SELECT id FROM verification_evidence WHERE milestone_id = ? AND slice_id = ? AND task_id = ?",
  ).all("M001", "S01", "T01");
  assert.equal(evidence.length, 1, "same-task repair must not duplicate completion evidence");
});
