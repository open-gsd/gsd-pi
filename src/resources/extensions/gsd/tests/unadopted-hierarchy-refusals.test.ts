// Project/App: gsd-pi
// File Purpose: A hierarchy row without a canonical lifecycle row is refused
// by every workflow tool with one loud error naming the adoption path.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";

import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { resolveTaskCompletionAuthority } from "../task-completion-compatibility-adapter.ts";
import { handleCompleteMilestone } from "../tools/complete-milestone.ts";
import { handleValidateMilestone } from "../tools/validate-milestone.ts";
import { handleReopenMilestone } from "../tools/reopen-milestone.ts";
import { handleReopenSlice } from "../tools/reopen-slice.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";

const tempDirs = new Set<string>();

function makeUnadoptedProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-unadopted-refusal-"));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  // The closeout captures its tested source revision from the repository.
  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  writeFileSync(join(base, "source.ts"), "export const source = 1;\n");
  execFileSync("git", ["init"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: base });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base });
  execFileSync("git", ["add", ".gitignore", "source.ts"], { cwd: base });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: base, stdio: "ignore" });
  openDatabase(join(base, ".gsd", "gsd.db"));
  // Raw hierarchy rows with no lifecycle row: the pre-adoption shape. Writes
  // through the generic status writer refuse these; so must every tool.
  insertMilestone({ id: "M001", title: "Unadopted", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });
  return base;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

const invocation = internalExecutionInvocation("test/unadopted-refusal");

test("task completion authority refuses a hierarchy row with no lifecycle row", () => {
  makeUnadoptedProject();
  assert.throws(
    () => resolveTaskCompletionAuthority({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return /Canonical Task completion lifecycle is missing/.test(message)
        && /gsd_plan_slice/.test(message)
        && /\/gsd db adopt --apply/.test(message);
    },
  );
});

test("milestone completion refuses a hierarchy row with no lifecycle row", async () => {
  const base = makeUnadoptedProject();
  const result = await handleCompleteMilestone({
    milestoneId: "M001",
    title: "Unadopted",
    oneLiner: "Done",
    narrative: "Done",
    verificationPassed: true,
  }, base, invocation);
  assert.ok("error" in result, JSON.stringify(result));
  // The canonical closeout stops on its first unsatisfied guard (validation
  // receipt, then lifecycle authority) — either way it is a loud refusal.
  assert.match(result.error, /canonical|Milestone M001/i);
});

test("milestone validation refuses a hierarchy row with no lifecycle row", async () => {
  const base = makeUnadoptedProject();
  const result = await handleValidateMilestone({
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x]",
    sliceDeliveryAudit: "Delivered",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verdictRationale: "Everything passes.",
  }, base, { invocation });
  assert.ok("error" in result);
  assert.match(result.error, /unresolved canonical lifecycle shadows/);
  assert.match(result.error, /M001/);
  assert.match(result.error, /gsd db adopt --apply/);
});

test("milestone reopen refuses a hierarchy row with no lifecycle row", async () => {
  const base = makeUnadoptedProject();
  const result = await handleReopenMilestone({ milestoneId: "M001" }, base, invocation);
  assert.ok("error" in result);
  assert.match(result.error, /has no canonical lifecycle row/);
  assert.match(result.error, /\/gsd db adopt/);
});

test("slice reopen refuses on the listed unadopted rows", async () => {
  const base = makeUnadoptedProject();
  const result = await handleReopenSlice(
    { milestoneId: "M001", sliceId: "S01" },
    base,
    invocation,
  );
  assert.ok("error" in result);
  assert.match(result.error, /unresolved canonical lifecycle shadows/);
  assert.match(result.error, /M001\/S01/);
});
