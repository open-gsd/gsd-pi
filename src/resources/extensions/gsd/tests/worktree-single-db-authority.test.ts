// gsd-pi — Behavior tests: one project database for a worktree run (ADR-046).
//
// A worktree run writes the project database only. Root projections in the
// worktree equal the project-root render, no file flows from the worktree to
// the project root, and a worktree-local gsd.db is merged only by the
// explicit import.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { assertMilestoneDbReadyForMerge } from "../auto-worktree-merge-db-ready.ts";
import { setActiveWorkspace } from "../auto-worktree-session-registry.ts";
import { teardownAutoWorktree } from "../auto-worktree-teardown.ts";
import {
  generateRequirementsMd,
  readDecisionsProjectionIntent,
  saveDecisionToDb,
  saveRequirementToDb,
} from "../db-writer.ts";
import { _getAdapter, closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { readKnowledgeMarkdown } from "../knowledge-projection.ts";
import { createMemory } from "../memory-store.ts";
import { _clearGsdRootCache } from "../paths.ts";
import type { Requirement } from "../types.ts";
import { importWorktreeLocalDb } from "../worktree-command.ts";
import { WorktreeStateProjection } from "../worktree-state-projection.ts";
import { createWorkspace, scopeMilestone } from "../workspace.ts";
import { copyWorktreeDb } from "./helpers/worktree-db-fixture.ts";

/** A project root with an open project database and a worktree at the canonical container path. */
function makeWorktreeProject(t: TestContext): { base: string; wt: string; mainDb: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-p28-")));
  const wt = join(base, ".gsd-worktrees", "M001");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  mkdirSync(join(wt, ".gsd"), { recursive: true });
  const mainDb = join(base, ".gsd", "gsd.db");
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    setActiveWorkspace(null);
    closeDatabase();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  });
  assert.equal(openDatabase(mainDb), true);
  return { base, wt, mainDb };
}

function requirementsDbRender(): string {
  const rows = _getAdapter()!.prepare("SELECT * FROM requirements ORDER BY id").all() as unknown as Requirement[];
  return generateRequirementsMd(rows.filter((row) => row.superseded_by == null));
}

async function assertBothRootsEqualDbRender(base: string, wt: string, mustContain: string[]): Promise<void> {
  const renders: Record<string, string> = {
    "DECISIONS.md": (await readDecisionsProjectionIntent(base))!.content,
    "REQUIREMENTS.md": requirementsDbRender(),
    "KNOWLEDGE.md": readKnowledgeMarkdown(base),
  };
  for (const [file, render] of Object.entries(renders)) {
    assert.equal(readFileSync(join(base, ".gsd", file), "utf-8"), render, `project-root ${file} equals the database render`);
    assert.equal(readFileSync(join(wt, ".gsd", file), "utf-8"), render, `worktree ${file} equals the database render`);
  }
  const all = Object.values(renders).join("\n");
  for (const text of mustContain) assert.ok(all.includes(text), `the database render holds "${text}"`);
}

function saveDecision(wt: string, decision: string): Promise<{ id: string }> {
  return saveDecisionToDb({
    when_context: "M001",
    scope: "M001",
    decision,
    choice: "yes",
    rationale: "test",
    revisable: "Yes",
    made_by: "agent",
  }, wt);
}

function saveRequirement(wt: string, description: string): Promise<{ id: string }> {
  return saveRequirementToDb({
    class: "primary-user-loop",
    status: "active",
    description,
    why: "test",
    source: "user",
    primary_owner: "M001/none yet",
    supporting_slices: "none",
    validation: "unmapped",
  }, wt);
}

function saveRule(id: string, rule: string): void {
  createMemory({ category: "rule", content: rule, structuredFields: { sourceKnowledgeId: id, rule } });
}

test("worktree and project-root KNOWLEDGE, DECISIONS and REQUIREMENTS equal the database render after each database write", async (t) => {
  const { base, wt } = makeWorktreeProject(t);
  const projection = new WorktreeStateProjection();
  const scope = scopeMilestone(createWorkspace(wt), "M001");

  // A worktree session writes through the worktree base path.
  await saveDecision(wt, "First decision");
  await saveRequirement(wt, "First requirement");
  saveRule("K001", "First rule");
  projection.projectRootToWorktree(scope); // worktree entry
  await assertBothRootsEqualDbRender(base, wt, ["First decision", "First requirement", "First rule"]);

  await saveDecision(wt, "Second decision");
  await saveRequirement(wt, "Second requirement");
  saveRule("K002", "Second rule");
  projection.refreshRootProjections(scope); // after a unit
  await assertBothRootsEqualDbRender(base, wt, ["Second decision", "Second requirement", "Second rule"]);
});

test("project-root metrics.json never goes backward to a worktree copy", (t) => {
  const { base, wt } = makeWorktreeProject(t);
  const projection = new WorktreeStateProjection();
  const scope = scopeMilestone(createWorkspace(wt), "M001");
  const rootMetrics = JSON.stringify({ version: 1, units: [{ id: "M001/S01/T01" }, { id: "M001/S01/T02" }] });
  writeFileSync(join(base, ".gsd", "metrics.json"), rootMetrics);
  // A snapshot that an older release left in the worktree.
  writeFileSync(join(wt, ".gsd", "metrics.json"), JSON.stringify({ version: 1, units: [{ id: "M001/S01/T01" }] }));

  projection.projectRootToWorktree(scope);
  projection.refreshRootProjections(scope);
  assert.equal(readFileSync(join(base, ".gsd", "metrics.json"), "utf-8"), rootMetrics);

  // A new worktree gets no metrics.json copy: the project root holds the only one.
  const second = join(base, ".gsd-worktrees", "M002");
  mkdirSync(join(second, ".gsd"), { recursive: true });
  projection.projectRootToWorktree(scopeMilestone(createWorkspace(second), "M002"));
  assert.equal(existsSync(join(second, ".gsd", "metrics.json")), false);
});

/** Give the worktree its own gsd.db whose M001 row differs from the project row. */
function seedWorktreeLocalDb(mainDb: string, wt: string): string {
  insertMilestone({ id: "M001", title: "Project title", status: "active" });
  closeDatabase();
  const wtDb = join(wt, ".gsd", "gsd.db");
  assert.equal(copyWorktreeDb(mainDb, wtDb), true);
  assert.equal(openDatabase(wtDb), true);
  _getAdapter()!.prepare("UPDATE milestones SET title = 'Worktree title', status = 'complete' WHERE id = 'M001'").run();
  closeDatabase();
  assert.equal(openDatabase(mainDb), true);
  return wtDb;
}

function projectMilestoneRows(): unknown[] {
  return _getAdapter()!.prepare("SELECT id, title, status, completed_at FROM milestones ORDER BY id").all();
}

test("a worktree-local gsd.db stops the milestone merge with the import instruction and changes no project row", (t) => {
  const { base, wt, mainDb } = makeWorktreeProject(t);
  const wtDb = seedWorktreeLocalDb(mainDb, wt);
  const before = projectMilestoneRows();

  assert.throws(
    () => assertMilestoneDbReadyForMerge({ milestoneId: "M001", projectRoot: base, worktreeCwd: wt }),
    /Milestone M001 merge blocked: worktree-local database found.*\/worktree import-db M001/,
  );
  assert.deepEqual(projectMilestoneRows(), before);
  assert.equal(existsSync(wtDb), true);
});

test("auto-worktree teardown keeps a worktree that holds its own gsd.db and changes no project row", (t) => {
  const { base, wt, mainDb } = makeWorktreeProject(t);
  const wtDb = seedWorktreeLocalDb(mainDb, wt);
  const before = projectMilestoneRows();

  setActiveWorkspace(createWorkspace(wt));
  process.chdir(wt);
  teardownAutoWorktree(base, "M001");

  assert.equal(existsSync(wtDb), true, "the worktree and its database are kept");
  assert.deepEqual(projectMilestoneRows(), before);
});

test("the explicit import previews without a row change, then merges the rows and moves the file aside", async (t) => {
  const { wt, mainDb } = makeWorktreeProject(t);
  const wtDb = seedWorktreeLocalDb(mainDb, wt);
  const before = projectMilestoneRows();

  let previewedMilestones = 0;
  const cancelled = await importWorktreeLocalDb(mainDb, wtDb, async (preview) => {
    previewedMilestones = preview.milestones;
    return false;
  });
  assert.equal(cancelled, "cancelled");
  assert.equal(previewedMilestones, 1, "the preview counts the row that would change");
  assert.deepEqual(projectMilestoneRows(), before, "a preview and a cancel change no project row");
  assert.equal(existsSync(wtDb), true);

  assert.equal(await importWorktreeLocalDb(mainDb, wtDb, async () => true), "imported");
  const [row] = projectMilestoneRows() as Array<{ title: string; status: string }>;
  assert.equal(row!.title, "Worktree title");
  assert.equal(row!.status, "complete");
  assert.equal(existsSync(wtDb), false, "the imported file no longer blocks a merge");
  assert.equal(existsSync(`${wtDb}.imported`), true, "the imported file is kept");
  assert.equal(await importWorktreeLocalDb(mainDb, wtDb, async () => true), "absent");
});
