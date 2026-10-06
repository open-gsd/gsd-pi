// gsd-pi — Behavior tests: one project database for a worktree run (ADR-046).
//
// A worktree run writes the project database only. Root projections in the
// worktree equal the project-root render, no file flows from the worktree to
// the project root, and a worktree-local gsd.db is merged only by the
// explicit import.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { worktreeOwnDbPath } from "../auto-worktree-cleanup.ts";
import { assertMilestoneDbReadyForMerge } from "../auto-worktree-merge-db-ready.ts";
import { setActiveWorkspace } from "../auto-worktree-session-registry.ts";
import { teardownAutoWorktree } from "../auto-worktree-teardown.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  generateRequirementsMd,
  readDecisionsProjectionIntent,
  saveDecisionToDb,
  saveRequirementToDb,
} from "../db-writer.ts";
import { _getAdapter, closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { readKnowledgeMarkdown } from "../knowledge-projection.ts";
import { createMemory } from "../memory-store.ts";
import { _clearGsdRootCache, resolveMilestoneFile } from "../paths.ts";
import type { Requirement } from "../types.ts";
import { handleWorktreeCommand, importWorktreeLocalDb } from "../worktree-command.ts";
import { createWorktree } from "../worktree-manager.ts";
import { WorktreeStateProjection } from "../worktree-state-projection.ts";
import { createWorkspace, scopeMilestone } from "../workspace.ts";
import { copyWorktreeDb } from "./helpers/worktree-db-fixture.ts";
import { seedMergeReadyMilestone } from "./merge-ready-fixture.ts";

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

test("a gsd.db in shared external state is not a worktree-local database and does not stop the merge", (t) => {
  const { base, wt, mainDb } = makeWorktreeProject(t);
  assert.equal(worktreeOwnDbPath(wt), join(wt, ".gsd", "gsd.db"));

  // The worktree `.gsd` links to external state that holds a database, and
  // the project `.gsd` does not link there (the #1852 divergence).
  const external = realpathSync(mkdtempSync(join(tmpdir(), "gsd-p28-external-")));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  seedMergeReadyMilestone(base, "M001");
  assert.equal(copyWorktreeDb(mainDb, join(external, "gsd.db")), true);
  rmSync(join(wt, ".gsd"), { recursive: true });
  symlinkSync(external, join(wt, ".gsd"));

  assert.equal(worktreeOwnDbPath(wt), null);
  assertMilestoneDbReadyForMerge({ milestoneId: "M001", projectRoot: base, worktreeCwd: wt });
  assert.equal(existsSync(join(external, "gsd.db")), true, "the external-state database is kept");
});

/** The revision of the project database and its count of Domain Operations. */
function projectAuthority(): unknown {
  return _getAdapter()!.prepare(
    "SELECT revision, (SELECT COUNT(*) FROM workflow_operations) AS operations FROM project_authority",
  ).get();
}

test("the explicit import previews without a row change, then merges the rows and moves the file aside", async (t) => {
  const { wt, mainDb } = makeWorktreeProject(t);
  const wtDb = seedWorktreeLocalDb(mainDb, wt);
  const before = projectMilestoneRows();
  const authorityBefore = projectAuthority();

  let previewedMilestones = 0;
  let previewedStatusChanges: string[] = [];
  const cancelled = await importWorktreeLocalDb(mainDb, wtDb, async (preview) => {
    previewedMilestones = preview.milestones;
    previewedStatusChanges = preview.statusChanges;
    return false;
  });
  assert.equal(cancelled, "cancelled");
  assert.equal(previewedMilestones, 1, "the preview counts the row that would change");
  assert.deepEqual(previewedStatusChanges, ['milestone M001: "active" -> "complete"'], "the preview names each status change");
  assert.deepEqual(projectMilestoneRows(), before, "a preview and a cancel change no project row");
  assert.deepEqual(projectAuthority(), authorityBefore, "a preview records no Domain Operation and no revision");
  assert.equal(existsSync(wtDb), true);

  const imported = await importWorktreeLocalDb(mainDb, wtDb, async () => true);
  assert.ok(typeof imported === "object", "the import ran");
  assert.deepEqual(projectAuthority(), {
    revision: (authorityBefore as { revision: number }).revision + 1,
    operations: (authorityBefore as { operations: number }).operations + 1,
  }, "the import is one Domain Operation with one revision");
  assert.ok(
    Number(_getAdapter()!.prepare("SELECT COUNT(*) AS n FROM workflow_projection_work").get()?.["n"]) > 0,
    "the import records Projection Work",
  );
  const [row] = projectMilestoneRows() as Array<{ title: string; status: string }>;
  assert.equal(row!.title, "Worktree title");
  assert.equal(row!.status, "complete");
  assert.equal(existsSync(wtDb), false, "the imported file no longer blocks a merge");
  assert.equal(existsSync(`${wtDb}.imported`), true, "the imported file is kept");
  assert.equal(await importWorktreeLocalDb(mainDb, wtDb, async () => true), "absent");

  // The backup is the project database before the import.
  closeDatabase();
  assert.equal(openDatabase(imported.backupPath), true);
  assert.deepEqual(projectMilestoneRows(), before);
});

test("the explicit import writes nothing when the project database changed after the preview", async (t) => {
  const { wt, mainDb } = makeWorktreeProject(t);
  const wtDb = seedWorktreeLocalDb(mainDb, wt);

  await assert.rejects(
    importWorktreeLocalDb(mainDb, wtDb, async () => {
      // Another session changes the project row while the operator reads the preview.
      _getAdapter()!.prepare("UPDATE milestones SET status = 'queued' WHERE id = 'M001'").run();
      return true;
    }),
    /no longer equals the confirmed preview; nothing was imported/,
  );

  const [row] = projectMilestoneRows() as Array<{ title: string; status: string }>;
  assert.equal(row!.title, "Project title", "no worktree value is written");
  assert.equal(row!.status, "queued");
  assert.equal(existsSync(wtDb), true, "the worktree database stays for the next import");
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

/** A git project with one commit and no GSD state. */
function makeGitProject(t: TestContext): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-p28-manual-")));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    closeDatabase();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  });
  git(["init", "-b", "main"], base);
  git(["config", "user.name", "Test"], base);
  git(["config", "user.email", "test@example.invalid"], base);
  git(["config", "commit.gpgsign", "false"], base);
  writeFileSync(join(base, ".gitignore"), ".gsd\n.gsd-worktrees\n");
  writeFileSync(join(base, "README.md"), "# project\n");
  git(["add", "."], base);
  git(["commit", "-m", "init"], base);
  return base;
}

/** Add a manual worktree "feature" that holds one commit. Returns its path. */
function addFeatureWorktree(base: string): string {
  const worktree = createWorktree(base, "feature");
  writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true;\n");
  git(["add", "feature.ts"], worktree.path);
  git(["commit", "-m", "feat: feature"], worktree.path);
  process.chdir(base);
  return worktree.path;
}

/**
 * A git project with an open project database, a milestone whose root ROADMAP
 * file is stale, and the manual worktree "feature".
 */
function makeManualWorktreeProject(t: TestContext): { base: string; wt: string; mainDb: string } {
  const base = makeGitProject(t);
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), "# M001\n\n## Slices\n- [ ] **S01: File slice**\n");
  const mainDb = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(mainDb), true);
  insertMilestone({ id: "M001", title: "Manual merge", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Database slice", status: "pending", risk: "low", depends: [], demo: "demo", sequence: 1 });

  return { base, wt: addFeatureWorktree(base), mainDb };
}

function manualMergeContext(): { ctx: never; pi: never; notices: Array<{ message: string; level: string }> } {
  const notices: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      custom: async () => true, // the operator confirms the merge
    },
  };
  return { ctx: ctx as never, pi: { sendMessage: () => {} } as never, notices };
}

test("the manual worktree merge renders the project-root projections from the database", async (t) => {
  const { base } = makeManualWorktreeProject(t);
  const { ctx, pi, notices } = manualMergeContext();

  await handleWorktreeCommand("merge feature", ctx, pi, "worktree");

  assert.equal(existsSync(join(base, "feature.ts")), true, `the worktree commit is merged: ${JSON.stringify(notices)}`);
  const roadmap = readFileSync(resolveMilestoneFile(base, "M001", "ROADMAP")!, "utf-8");
  assert.match(roadmap, /Database slice/, "the root ROADMAP is the database render after the merge");
  assert.doesNotMatch(roadmap, /File slice/);
});

test("the manual worktree merge writes no .gsd file in a repository that has no project database", async (t) => {
  const base = makeGitProject(t);
  addFeatureWorktree(base);
  const { ctx, pi, notices } = manualMergeContext();

  await handleWorktreeCommand("merge feature", ctx, pi, "worktree");

  assert.equal(existsSync(join(base, "feature.ts")), true, `the worktree commit is merged: ${JSON.stringify(notices)}`);
  assert.equal(existsSync(join(base, ".gsd")), false, "the merge creates no GSD state");
});

test("the manual worktree merge stops on a worktree-local gsd.db with the import instruction", async (t) => {
  const { base, wt, mainDb } = makeManualWorktreeProject(t);
  const { ctx, pi, notices } = manualMergeContext();
  closeDatabase();
  assert.equal(copyWorktreeDb(mainDb, join(wt, ".gsd", "gsd.db")), true);
  assert.equal(openDatabase(mainDb), true);
  const before = projectMilestoneRows();

  await handleWorktreeCommand("merge feature", ctx, pi, "worktree");

  assert.equal(existsSync(join(base, "feature.ts")), false, "nothing is merged");
  assert.ok(
    notices.some(({ message, level }) => level === "error" && /\/worktree import-db feature/.test(message)),
    `the stop names the explicit import: ${JSON.stringify(notices)}`,
  );
  assert.deepEqual(projectMilestoneRows(), before);
});

/** The agent_end handlers of the real hook registration. */
function agentEndHooks(): () => Promise<void> {
  const handlers: Array<(event: unknown, ctx: unknown) => Promise<unknown>> = [];
  registerHooks({
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (name === "agent_end") handlers.push(handler);
    },
  } as never, []);
  const ctx = { ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} } };
  return async () => {
    for (const handler of handlers) await handler({ messages: [] }, ctx);
  };
}

test("the LLM-guided manual worktree merge renders the project-root projections after its commit", async (t) => {
  const { base, wt } = makeManualWorktreeProject(t);
  // Both sides change README.md, so the deterministic merge is in conflict.
  writeFileSync(join(wt, "README.md"), "# worktree\n");
  git(["commit", "-am", "docs: worktree readme"], wt);
  writeFileSync(join(base, "README.md"), "# main\n");
  git(["commit", "-am", "docs: main readme"], base);
  const agentEnd = agentEndHooks();

  const { ctx, notices } = manualMergeContext();
  const sent: unknown[] = [];
  await handleWorktreeCommand("merge feature", ctx, { sendMessage: (message: unknown) => sent.push(message) } as never, "worktree");
  assert.equal(sent.length, 1, `the merge goes to the LLM helper: ${JSON.stringify(notices)}`);

  // The agent ends a turn before it merges (it asks the operator first).
  await agentEnd();
  assert.match(
    readFileSync(resolveMilestoneFile(base, "M001", "ROADMAP")!, "utf-8"),
    /File slice/,
    "nothing is rendered before the merge commit",
  );

  // The agent merges and commits.
  assert.throws(() => git(["merge", "--squash", git(["rev-parse", "--abbrev-ref", "HEAD"], wt)], base));
  git(["checkout", "--theirs", "--", "README.md"], base);
  git(["add", "README.md"], base);
  git(["commit", "-m", "merge(worktree/feature): feature"], base);
  await agentEnd();

  const roadmap = readFileSync(resolveMilestoneFile(base, "M001", "ROADMAP")!, "utf-8");
  assert.match(roadmap, /Database slice/, "the root ROADMAP is the database render after the LLM merge");
  assert.doesNotMatch(roadmap, /File slice/);
});
