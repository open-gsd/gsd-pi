import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearUnitRuntimeRecord,
  formatExecuteTaskRecoveryStatus,
  inspectExecuteTaskDurability,
  isInFlightRuntimePhase,
  readUnitHarnessAbort,
  readUnitRuntimeRecord,
  recordUnitHarnessAbort,
  writeUnitRuntimeRecord,
} from "../unit-runtime.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { clearPathCache } from '../paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const base = mkdtempSync(join(tmpdir(), "gsd-unit-runtime-test-"));
const tasksDir = join(base, ".gsd", "milestones", "M100", "slices", "S02", "tasks");
mkdirSync(tasksDir, { recursive: true });
writeFileSync(join(base, ".gsd", "STATE.md"), "## Next Action\nExecute T09 for S02: do the thing\n", "utf-8");
writeFileSync(
  join(base, ".gsd", "milestones", "M100", "slices", "S02", "S02-PLAN.md"),
  "# S02: Test Slice\n\n## Tasks\n\n- [ ] **T09: Do the thing** `est:10m`\n  Description.\n",
  "utf-8",
);

// The runtime record is a database row, so the record sections need an open database.
openDatabase(join(base, ".gsd", "gsd.db"));

console.log("\n=== in-flight runtime phases ===");
{
  assert.equal(isInFlightRuntimePhase("crashed"), true, "crashed records remain recoverable");
  assert.equal(isInFlightRuntimePhase("finalized"), false, "finalized records are terminal");
}

console.log("\n=== runtime record write/read/update ===");
{
  const first = writeUnitRuntimeRecord(base, "execute-task", "M100/S02/T09", 1000, { phase: "dispatched" });
  assert.deepStrictEqual(first.phase, "dispatched", "initial phase");
  const second = writeUnitRuntimeRecord(base, "execute-task", "M100/S02/T09", 1000, { phase: "wrapup-warning-sent", wrapupWarningSent: true });
  assert.deepStrictEqual(second.wrapupWarningSent, true, "warning persisted");
  const loaded = readUnitRuntimeRecord(base, "execute-task", "M100/S02/T09");
  assert.ok(loaded !== null, "record readable");
  assert.deepStrictEqual(loaded!.phase, "wrapup-warning-sent", "updated phase readable");
}

console.log("\n=== runtime harness abort preservation and explicit clear ===");
{
  const startedAt = 3000;
  recordUnitHarnessAbort(base, "gate-evaluate", "M100/S02/gates+Q3", startedAt, {
    kind: "tool-error",
    reason: "Tool execution failed before the unit could complete its gate evaluation.",
    toolName: "browser_click",
  });

  const preserved = writeUnitRuntimeRecord(base, "gate-evaluate", "M100/S02/gates+Q3", startedAt, {
    phase: "wrapup-warning-sent",
  });
  assert.equal(preserved.harnessAbort?.kind, "tool-error", "ordinary same-run updates preserve harness abort");

  const cleared = writeUnitRuntimeRecord(base, "gate-evaluate", "M100/S02/gates+Q3", startedAt, {
    phase: "recovered",
    harnessAbort: undefined,
  });
  assert.equal(cleared.harnessAbort, undefined, "explicit clear removes stale harness abort");
  assert.equal(
    readUnitHarnessAbort(base, "gate-evaluate", "M100/S02/gates+Q3", startedAt),
    null,
    "cleared harness abort no longer blocks result saves",
  );

  clearUnitRuntimeRecord(base, "gate-evaluate", "M100/S02/gates+Q3");
}

console.log("\n=== execute-task durability reads the task row only ===");
{
  const before = inspectExecuteTaskDurability("M100/S02/T09");
  assert.deepStrictEqual(before, { dbComplete: false }, "no task row: not closed");

  // Every projection says T09 is done and well covered. None of them is read.
  writeFileSync(
    join(tasksDir, "T09-PLAN.md"),
    "# T09: Do the thing\n\n## Must-Haves\n\n- [ ] `doTheThing` is exported\n",
    "utf-8",
  );
  writeFileSync(join(tasksDir, "T09-SUMMARY.md"), "# done\n\nExported doTheThing.\n", "utf-8");
  writeFileSync(
    join(base, ".gsd", "milestones", "M100", "slices", "S02", "S02-PLAN.md"),
    "# S02: Test Slice\n\n## Tasks\n\n- [x] **T09: Do the thing** `est:10m`\n  Description.\n",
    "utf-8",
  );
  writeFileSync(join(base, ".gsd", "STATE.md"), "## Next Action\nExecute T10 for S02: next thing\n", "utf-8");
  clearPathCache();

  const after = inspectExecuteTaskDurability("M100/S02/T09");
  assert.deepStrictEqual(after, before, "SUMMARY, PLAN and STATE.md files do not change the status");
  assert.deepStrictEqual(formatExecuteTaskRecoveryStatus(after!), "DB task status is not closed");
}

console.log("\n=== runtime record cleanup ===");
{
  clearUnitRuntimeRecord(base, "execute-task", "M100/S02/T09");
  const loaded = readUnitRuntimeRecord(base, "execute-task", "M100/S02/T09");
  assert.deepStrictEqual(loaded, null, "record removed");
}

closeDatabase();

console.log("\n=== execute-task durability trusts closed DB task status ===");
{
  const dbBase = mkdtempSync(join(tmpdir(), "gsd-unit-runtime-db-test-"));
  mkdirSync(join(dbBase, ".gsd", "milestones", "M300", "slices", "S01", "tasks"), { recursive: true });
  try {
    openDatabase(join(dbBase, ".gsd", "gsd.db"));
    insertMilestone({ id: "M300", title: "DB Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M300", title: "DB Slice", status: "in_progress" });
    insertTask({ id: "T01", milestoneId: "M300", sliceId: "S01", title: "DB Task", status: "complete" });
    writeFileSync(
      join(dbBase, ".gsd", "milestones", "M300", "slices", "S01", "S01-PLAN.md"),
      "# S01\n\n## Tasks\n\n- [ ] **T01: DB Task** `est:10m`\n",
      "utf-8",
    );
    writeFileSync(join(dbBase, ".gsd", "STATE.md"), "## Next Action\nExecute T01 for S01: DB task\n", "utf-8");

    const status = inspectExecuteTaskDurability("M300/S01/T01");
    assert.deepStrictEqual(status, { dbComplete: true }, "db-complete: a closed row needs no SUMMARY file");
    assert.equal(formatExecuteTaskRecoveryStatus(status!), "DB task status is closed");

    // The inverse contradiction: PLAN and STATE.md say T02 is done, the DB says pending.
    insertTask({ id: "T02", milestoneId: "M300", sliceId: "S01", title: "Open Task", status: "pending" });
    writeFileSync(
      join(dbBase, ".gsd", "milestones", "M300", "slices", "S01", "S01-PLAN.md"),
      "# S01\n\n## Tasks\n\n- [x] **T02: Open Task** `est:10m`\n",
      "utf-8",
    );
    writeFileSync(join(dbBase, ".gsd", "STATE.md"), "## Next Action\nExecute T03 for S01: later task\n", "utf-8");
    writeFileSync(
      join(dbBase, ".gsd", "milestones", "M300", "slices", "S01", "tasks", "T02-SUMMARY.md"),
      "# done\n",
      "utf-8",
    );
    clearPathCache();
    const open = inspectExecuteTaskDurability("M300/S01/T02");
    assert.equal(open!.dbComplete, false, "db-pending: files cannot close the task");
    assert.equal(formatExecuteTaskRecoveryStatus(open!), "DB task status is not closed");
  } finally {
    closeDatabase();
    rmSync(dbBase, { recursive: true, force: true });
  }
}

console.log("\n=== hook unit type sanitization (slash in unitType) ===");
{
  // Hook units have unitType like "hook/code-review" with a slash
  // This should NOT create a subdirectory - the slash must be sanitized
  openDatabase(join(base, ".gsd", "gsd.db"));
  const hookRecord = writeUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10", 2000, { phase: "dispatched" });
  assert.deepStrictEqual(hookRecord.unitType, "hook/code-review", "unitType preserved in record");
  assert.deepStrictEqual(hookRecord.unitId, "M100/S02/T10", "unitId preserved in record");
  
  const loaded = readUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10");
  assert.ok(loaded !== null, "hook record readable");
  assert.deepStrictEqual(loaded!.phase, "dispatched", "hook phase correct");
  
  // Verify the file is in the units dir, not in a subdirectory
  const unitsDir = join(base, ".gsd", "runtime", "units");
  const files = readdirSync(unitsDir);
  const hookFile = files.find((f: string) => f.includes("hook-code-review"));
  assert.ok(hookFile !== undefined, "hook file exists with sanitized name");
  assert.ok(!files.some((f: string) => f === "hook"), "no 'hook' subdirectory created");
  
  clearUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10");
  const cleared = readUnitRuntimeRecord(base, "hook/code-review", "M100/S02/T10");
  assert.deepStrictEqual(cleared, null, "hook record removed");
  closeDatabase();
}

rmSync(base, { recursive: true, force: true });
