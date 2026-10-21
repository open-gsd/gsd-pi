import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { handleCompleteTask } from "../tools/complete-task.js";
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertMilestone,
  insertSlice,
} from "../gsd-db.js";
import { clearPathCache } from "../paths.js";
import { clearParseCache } from "../files.js";
import { _setManagedMutationBoundaryForTest } from "../atomic-write.js";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-ct-rollback-${randomUUID()}`);
  // Create the full tasks directory so the success path works
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

const VALID_PARAMS = {
  milestoneId: "M001",
  sliceId: "S01",
  taskId: "T01",
  oneLiner: "Test task",
  narrative: "Did the thing",
  verification: "Checked it",
  deviations: "None.",
  knownIssues: "None.",
  keyFiles: ["src/foo.ts"],
  keyDecisions: ["Used approach A"],
  blockerDiscovered: false,
  verificationEvidence: [
    { command: "npm test", exitCode: 0, verdict: "✅ pass", durationMs: 1000 },
    { command: "npm run lint", exitCode: 0, verdict: "✅ pass", durationMs: 500 },
  ],
};

describe("complete-task projection failures preserve committed DB completion", () => {
  let base: string;

  afterEach(() => {
    clearPathCache();
    clearParseCache();
    try { closeDatabase(); } catch { /* */ }
    if (base) {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("inserts verification_evidence rows on success", async () => {
    base = makeTmpBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    // Write a minimal slice plan so renderPlanCheckboxes doesn't error
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
      "# S01 Plan\n\n## Tasks\n\n- [ ] **T01: Test task**\n",
    );

    const result = await handleCompleteTask(VALID_PARAMS, base);
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    const adapter = _getAdapter()!;
    const rows = adapter.prepare(
      `SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'`,
    ).all();
    assert.equal(rows.length, 2, "should have 2 evidence rows after success");
  });

  it("reopens the workflow DB when it disappears between SUMMARY.md write and plan render", async (t) => {
    base = makeTmpBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    writeFileSync(
      planPath,
      "# S01 Plan\n\n## Tasks\n\n- [ ] **T01: Test task**\n",
    );

    let closedAfterSummaryWrite = false;
    t.after(() => _setManagedMutationBoundaryForTest(null));
    _setManagedMutationBoundaryForTest((boundary, target) => {
      if (boundary === "after-write" && !closedAfterSummaryWrite && target.endsWith("T01-SUMMARY.md")) {
        closedAfterSummaryWrite = true;
        _setManagedMutationBoundaryForTest(null);
        closeDatabase();
      }
    });

    const result = await handleCompleteTask(VALID_PARAMS, base);
    assert.ok(closedAfterSummaryWrite, "test fixture should close DB after SUMMARY.md atomic rename");
    assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

    const content = readFileSync(planPath, "utf-8");
    assert.match(content, /\[x\][^\n]*\*\*T01\*\*/, "PLAN.md checkbox should be rendered after DB reopen");

    const adapter = _getAdapter()!;
    const task = adapter.prepare(
      `SELECT status FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'`,
    ).get() as { status: string } | undefined;
    assert.equal(task?.status, "complete", "task should remain complete after successful projection");
  });

  it("keeps DB completion and verification evidence when disk projection write fails", async () => {
    base = makeTmpBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    // Replace the tasks directory with a file so disk write fails (cross-platform)
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    rmSync(tasksDir, { recursive: true, force: true });
    writeFileSync(tasksDir, "not-a-directory");

    const result = await handleCompleteTask(VALID_PARAMS, base);
    assert.ok("error" in result, "expected stale projection error when projection write fails");
    assert.ok(
      (result as { error: string }).error.includes("completion remains committed"),
      `error should report committed completion; got: ${"error" in result ? result.error : ""}`,
    );

    const adapter = _getAdapter()!;
    const task = adapter.prepare(
      `SELECT status FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'`,
    ).get() as { status: string } | undefined;
    assert.ok(task, "task row should still exist after projection failure");
    assert.equal(task!.status, "complete", "task completion should remain committed");

    const evidenceRows = adapter.prepare(
      `SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'`,
    ).all();
    assert.equal(evidenceRows.length, 2, "verification evidence should remain committed for projection repair");
  });
});
