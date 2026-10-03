// Project/App: gsd-pi
// File Purpose: Behavior tests — one workflow database per bound checkout, and the tracked-.gsd team model.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapAutoSession } from "../auto-start.ts";
import { AutoSession } from "../auto/session.ts";
import { ensureDbOpen } from "../bootstrap/dynamic-tools.ts";
import { handleDbBind, handleRebuild, handleRecover } from "../commands-maintenance.ts";
import {
  ensureWorkflowDbAtPath,
  ensureWorkflowDbForBase,
  getWorkflowDatabasePath,
  isWorkflowDatabaseOpen,
  openWorkflowDatabase,
  openWorkflowDatabasePath,
  resolveProjectRootDbPath,
} from "../db-workspace.ts";
import { GitServiceImpl } from "../git-service.ts";
import { showSmartEntry } from "../guided-flow.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { describeHeldProjectionChanges, preserveProjectionChangesBeforeDispatch } from "../projection-worker.ts";
import { ensureGsdSymlink } from "../repo-identity.ts";
import { reconcileBeforeSpawn } from "../state-reconciliation/spawn-gate.ts";
import { invalidateStateCache } from "../state.ts";
import { openSqliteReadOnly } from "../sqlite-readonly.ts";
import { executeSummarySave } from "../tools/workflow-tool-executors.ts";

const tempDirs = new Set<string>();
const savedEnv = { GSD_STATE_DIR: process.env.GSD_STATE_DIR, GSD_PROJECT_ID: process.env.GSD_PROJECT_ID };

afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.add(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
}

function makeCtx(): { ctx: any; notes: Array<{ message: string; level?: string }> } {
  const notes: Array<{ message: string; level?: string }> = [];
  const model = { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 128000 };
  return {
    notes,
    ctx: {
      ui: {
        notify: (message: string, level?: string) => notes.push({ message, level }),
        setStatus: () => {},
        setWidget: () => {},
      },
      model,
      modelRegistry: {
        getAvailable: () => [model],
        isProviderRequestReady: () => true,
        getProviderAuthMode: () => "oauth",
      },
      sessionManager: {
        getSessionId: () => "bound-checkout-test",
        getSessionFile: () => null,
        getEntries: () => [],
      },
    },
  };
}

function boundRoot(dbPath: string): unknown {
  const { db } = openSqliteReadOnly(dbPath);
  try {
    return db.prepare("SELECT project_root_realpath FROM project_authority WHERE singleton = 1").get()?.["project_root_realpath"];
  } finally {
    db.close();
  }
}

test("a second clone of one remote opens the same state dir and is refused until bound", async () => {
  process.env.GSD_STATE_DIR = tempDir("gsd-bound-state-");
  delete process.env.GSD_PROJECT_ID;
  const first = tempDir("gsd-clone-a-");
  const second = tempDir("gsd-clone-b-");
  for (const clone of [first, second]) {
    initRepo(clone);
    git(clone, "remote", "add", "origin", "https://example.com/team/shared.git");
    ensureGsdSymlink(clone);
  }
  assert.equal(realpathSync(join(first, ".gsd")), realpathSync(join(second, ".gsd")), "both clones resolve to one state dir");

  assert.equal(openWorkflowDatabase(first).ok, true);
  closeDatabase();

  const refused = openWorkflowDatabase(second);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "checkout-unbound");
  assert.match(refused.error?.message ?? "", new RegExp(`belongs to the checkout at ${first}.*/gsd db bind`, "s"));
  await assert.rejects(ensureDbOpen(second), /checkout-unbound/);
  await assert.rejects(executeSummarySave({} as never, second), /checkout-unbound/);

  const { ctx, notes } = makeCtx();
  handleDbBind(ctx, second);
  assert.equal(notes.at(-1)?.level, "info", JSON.stringify(notes));
  closeDatabase();
  assert.equal(openWorkflowDatabase(second).ok, true);
  closeDatabase();
  assert.equal(openWorkflowDatabase(first).reason, "checkout-unbound", "the old root is refused after the binding moved");
});

test("a copied database with another root is refused for writes", async () => {
  const source = tempDir("gsd-bound-source-");
  const copy = tempDir("gsd-bound-copy-");
  mkdirSync(join(source, ".gsd"));
  mkdirSync(join(copy, ".gsd"));
  assert.equal(openWorkflowDatabase(source).ok, true);
  insertMilestone({ id: "M001", title: "Source work", status: "active" });
  closeDatabase();
  const copiedDb = join(copy, ".gsd", "gsd.db");
  copyFileSync(join(source, ".gsd", "gsd.db"), copiedDb);

  assert.equal(openWorkflowDatabase(copy).reason, "checkout-unbound");
  await assert.rejects(executeSummarySave({} as never, copy), /checkout-unbound: .*belongs to the checkout at/s);
  assert.equal(boundRoot(copiedDb), source, "the refused open must not rebind the copy");
});

test("a path-only open refuses a database that its bound checkout does not resolve to", () => {
  const source = tempDir("gsd-bound-path-source-");
  const copy = tempDir("gsd-bound-path-copy-");
  mkdirSync(join(source, ".gsd"));
  mkdirSync(join(copy, ".gsd"));
  assert.equal(openWorkflowDatabase(source).ok, true);
  insertMilestone({ id: "M001", title: "Source work", status: "active" });
  closeDatabase();
  const sourceDb = join(source, ".gsd", "gsd.db");
  const copiedDb = join(copy, ".gsd", "gsd.db");
  copyFileSync(sourceDb, copiedDb);

  assert.throws(() => openWorkflowDatabasePath(copiedDb), /checkout-unbound: .*belongs to the checkout at/s);
  assert.throws(() => ensureWorkflowDbAtPath(copiedDb), /checkout-unbound/);
  assert.equal(isWorkflowDatabaseOpen(), false, "a refused path-only open leaves no handle");
  assert.equal(boundRoot(copiedDb), source, "the refused open must not rebind the copy");
  assert.equal(ensureWorkflowDbAtPath(sourceDb), true, "the bound checkout's own database still reopens by path");
});

test("an empty database bound to another root beside a ROADMAP is bound here, then imported", () => {
  const old = tempDir("gsd-bound-old-");
  const moved = tempDir("gsd-bound-moved-");
  mkdirSync(join(old, ".gsd"));
  assert.equal(openWorkflowDatabase(old).ok, true);
  closeDatabase();
  mkdirSync(join(moved, ".gsd", "milestones", "M001"), { recursive: true });
  const movedDb = join(moved, ".gsd", "gsd.db");
  copyFileSync(join(old, ".gsd", "gsd.db"), movedDb);
  writeFileSync(join(moved, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001: Pulled plan\n");

  assert.equal(openWorkflowDatabase(moved).reason, "authority-missing");
  assert.equal(openWorkflowDatabase(moved, { createEmptyAuthority: true }).reason, "checkout-unbound", "the import open is refused before the bind");

  const { ctx, notes } = makeCtx();
  handleDbBind(ctx, moved);
  assert.equal(notes.at(-1)?.level, "info", JSON.stringify(notes));
  assert.equal(boundRoot(movedDb), moved);
  assert.equal(openWorkflowDatabase(moved).reason, "authority-missing", "the bind must not admit the empty database");
  assert.equal(openWorkflowDatabase(moved, { createEmptyAuthority: true }).ok, true, "the /gsd recover open now succeeds");
});

for (const existingDb of ["none", "schema-only"] as const) test(`a re-clone with tracked projections and ${existingDb === "none" ? "no" : "a schema-only"} database blocks auto, guided, headless and MCP writes`, async () => {
  const origin = tempDir("gsd-tracked-origin-");
  initRepo(origin);
  mkdirSync(join(origin, ".gsd", "phases", "01-foo"), { recursive: true });
  writeFileSync(join(origin, ".gsd", "phases", "01-foo", "01-ROADMAP.md"), "# M001: Team plan\n");
  writeFileSync(join(origin, ".gsd", "PREFERENCES.md"), "---\ngit:\n  isolation: \"none\"\n---\n");
  writeFileSync(join(origin, ".gitignore"), ".gsd/gsd.db*\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-m", "plan");
  const parent = tempDir("gsd-tracked-reclone-");
  git(parent, "clone", "-q", origin, "clone");
  const clone = join(parent, "clone");
  git(clone, "config", "user.email", "test@test.com");
  git(clone, "config", "user.name", "Test");
  const dbPath = join(clone, ".gsd", "gsd.db");
  const recoverInstruction = /authority-missing: .*\/gsd recover/s;
  if (existingDb === "schema-only") {
    // An older GSD silently created an empty database beside the projections.
    assert.equal(openDatabase(dbPath), true);
    closeDatabase();
  }

  // Guided flow and native tool handlers open through ensureDbOpen.
  await assert.rejects(ensureDbOpen(clone), recoverInstruction);
  // MCP and native workflow writes share the executor.
  await assert.rejects(executeSummarySave({} as never, clone), recoverInstruction);
  // Auto mode; headless auto runs this bootstrap in its RPC child.
  const { ctx, notes } = makeCtx();
  const ready = await bootstrapAutoSession(
    new AutoSession(),
    ctx,
    { getThinkingLevel: () => "medium", getActiveTools: () => [], events: { emit: () => {} } } as any,
    clone,
    false,
    false,
    {
      shouldUseWorktreeIsolation: () => false,
      registerSigtermHandler: () => {},
      registerAutoWorkerForSession: () => {},
      lockBase: () => clone,
      buildLifecycle: () => ({}) as any,
    },
    {
      classification: "none",
      lock: null,
      pausedSession: null,
      state: null,
      recovery: null,
      recoveryPrompt: null,
      recoveryToolCallCount: 0,
      artifactSatisfied: false,
      hasResumableDiskState: false,
      isBootstrapCrash: false,
    },
  );
  assert.equal(ready, false);
  assert.match(notes.find((note) => note.level === "error")?.message ?? "", recoverInstruction, JSON.stringify(notes));
  if (existingDb === "none") {
    assert.equal(existsSync(dbPath), false, "no empty database may be created beside tracked projections");
  } else {
    const { db } = openSqliteReadOnly(dbPath);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM milestones").get()?.["count"], 0, "nothing was written into the empty database");
    } finally {
      db.close();
    }
    assert.equal(openWorkflowDatabase(clone, { createEmptyAuthority: true }).ok, true, "the explicit import path still opens it");
  }
});

/** A schema-only database (as an older GSD created it) beside one planned milestone. */
function emptyDatabaseBesideRoadmap(prefix: string): { base: string; dbPath: string } {
  const base = tempDir(prefix);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  const dbPath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001: Pulled plan\n");
  return { base, dbPath };
}

test("the internal reopen seams refuse an empty database beside a planned milestone", () => {
  const { base, dbPath } = emptyDatabaseBesideRoadmap("gsd-empty-seams-");
  const recoverInstruction = /authority-missing: .*\/gsd recover/s;

  assert.throws(() => ensureWorkflowDbForBase(base), recoverInstruction);
  assert.throws(() => ensureWorkflowDbAtPath(dbPath), recoverInstruction);
  assert.throws(() => openWorkflowDatabasePath(dbPath), recoverInstruction);
  assert.equal(isWorkflowDatabaseOpen(), false, "a refused reopen leaves no handle");
  assert.equal(openWorkflowDatabase(base).reason, "authority-missing", "a reopen seam must not admit the database for a later entry point");
});

test("a declined recover leaves the empty database refused in the same process", async () => {
  const { base } = emptyDatabaseBesideRoadmap("gsd-empty-declined-");
  const { ctx, notes } = makeCtx();

  await handleRecover(ctx, base);

  assert.match(notes.at(-1)?.message ?? "", /No database changes made/, JSON.stringify(notes));
  await assert.rejects(ensureDbOpen(base), /authority-missing: .*\/gsd recover/s);
  await assert.rejects(executeSummarySave({} as never, base), /authority-missing/);
});

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** A tracked project whose T01 summary a teammate changed; this checkout pulled it. */
async function trackedProjectAfterPull(
  teammateChange: (teammate: string) => void = () => {},
): Promise<{ base: string; summaryPath: string; ctx: any }> {
  const base = tempDir("gsd-tracked-pull-");
  initRepo(base);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress", risk: "low", depends: [] });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task",
    status: "complete",
    oneLiner: "Task complete",
    narrative: "Canonical narrative.",
    verificationResult: "passed",
    fullSummaryMd: "# T01 Summary\n\nCanonical summary.\n",
  });
  const { ctx } = makeCtx();
  await handleRebuild(ctx, base, "markdown");
  const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");
  assert.match(readFileSync(summaryPath, "utf-8"), /Canonical summary/);
  writeFileSync(join(base, ".gitignore"), ".gsd/gsd.db*\n.gsd/.compat.json\n.gsd/quarantine/\n");
  git(base, "add", "-A");
  git(base, "commit", "-m", "plan");

  // A teammate changes the tracked projection; this checkout pulls it.
  const teammateParent = tempDir("gsd-tracked-teammate-");
  git(teammateParent, "clone", "-q", base, "teammate");
  const teammate = join(teammateParent, "teammate");
  git(teammate, "config", "user.email", "mate@test.com");
  git(teammate, "config", "user.name", "Mate");
  writeFileSync(join(teammate, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), "# T01 Summary\n\nTeammate edit.\n");
  teammateChange(teammate);
  git(teammate, "commit", "-qam", "teammate edit");
  git(base, "pull", "-q", "--ff-only", teammate, "main");
  return { base, summaryPath, ctx };
}

test("a pulled projection change raises one 'changed outside GSD' state and no dispatch proceeds without a choice", async () => {
  const { base, summaryPath, ctx } = await trackedProjectAfterPull();

  const observed = await preserveProjectionChangesBeforeDispatch(base);
  assert.deepEqual(observed.held, [summaryPath]);
  assert.deepEqual(observed.preserved, [], "a tracked change is not quarantined silently");
  assert.match(readFileSync(summaryPath, "utf-8"), /Teammate edit/);
  assert.equal(existsSync(join(base, ".gsd", "quarantine")), false);
  assert.match(
    describeHeldProjectionChanges(base, observed.held),
    /changed outside GSD: \.gsd\/milestones\/M001\/slices\/S01\/tasks\/T01-SUMMARY\.md\..*\/gsd recover.*\/gsd rebuild markdown/s,
  );

  // The state persists until the user chooses: every dispatch gate stays shut.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const gate = await reconcileBeforeSpawn(base);
    assert.equal(gate.ok, false);
    assert.match(gate.reason ?? "", /changed outside GSD/);
  }
  assert.match(readFileSync(summaryPath, "utf-8"), /Teammate edit/);

  // Discard choice: rebuild restores the database render and keeps the bytes.
  await handleRebuild(ctx, base, "markdown");
  assert.match(readFileSync(summaryPath, "utf-8"), /Canonical summary/);
  const quarantined = listFiles(join(base, ".gsd", "quarantine"));
  assert.equal(quarantined.length, 1);
  assert.match(readFileSync(quarantined[0]!, "utf-8"), /Teammate edit/);
  assert.deepEqual((await preserveProjectionChangesBeforeDispatch(base)).held, []);
});

test("guided entry does not self-heal over a pulled projection change: it keeps the change and stops", async () => {
  const roadmap = join(".gsd", "milestones", "M001", "M001-ROADMAP.md");
  // The pull also deletes the roadmap, so the hierarchy check asks for a markdown rebuild.
  const { base, summaryPath } = await trackedProjectAfterPull((teammate) => rmSync(join(teammate, roadmap)));
  assert.equal(existsSync(join(base, roadmap)), false);
  const notes: Array<{ message: string; level: string }> = [];

  await showSmartEntry(
    { hasUI: false, ui: { notify: (message: string, level: string) => notes.push({ message, level }), setStatus: () => {} } } as any,
    {
      sendMessage: () => { throw new Error("guided entry must not dispatch on old content"); },
      getActiveTools: () => [],
      setActiveTools: () => {},
    } as any,
    base,
  );

  assert.equal(notes.at(-1)?.level, "error", JSON.stringify(notes));
  assert.match(notes.at(-1)?.message ?? "", /changed outside GSD: .*T01-SUMMARY\.md/);
  assert.match(readFileSync(summaryPath, "utf-8"), /Teammate edit/, "the pulled change stays in place");
  assert.equal(existsSync(join(base, roadmap)), false, "no rebuild ran");
  assert.equal(existsSync(join(base, ".gsd", "quarantine")), false);
});

test("one resolver finds the database from gsd.db, not from projection files", () => {
  const root = tempDir("gsd-one-resolver-");
  initRepo(root);
  mkdirSync(join(root, ".gsd"));
  assert.equal(openWorkflowDatabase(root).ok, true);
  closeDatabase();
  // A nested project in flat-phase layout: its own gsd.db, no PREFERENCES.md, no milestones/.
  const nested = join(root, "packages", "app");
  mkdirSync(join(nested, ".gsd", "phases", "01-foo"), { recursive: true });
  const nestedDb = join(nested, ".gsd", "gsd.db");
  assert.equal(openDatabase(nestedDb), true);
  closeDatabase();

  assert.equal(resolveProjectRootDbPath(nested), nestedDb);
  assert.equal(ensureWorkflowDbForBase(nested), true);
  assert.equal(getWorkflowDatabasePath(), nestedDb);
});

test("tracked mode never commits the render baseline or the quarantine", () => {
  const base = tempDir("gsd-tracked-runtime-");
  initRepo(base);
  writeFileSync(join(base, "README.md"), "# repo\n");
  mkdirSync(join(base, ".gsd", "phases", "01-foo"), { recursive: true });
  mkdirSync(join(base, ".gsd", "quarantine", "projections", "stamp"), { recursive: true });
  writeFileSync(join(base, ".gsd", "phases", "01-foo", "01-ROADMAP.md"), "# M001\n");
  writeFileSync(join(base, ".gsd", ".compat.json"), "{}\n");
  writeFileSync(join(base, ".gsd", "quarantine", "projections", "stamp", "01-ROADMAP.md"), "# old\n");

  new GitServiceImpl(base).commit({ message: "chore: tracked planning" });

  const tracked = git(base, "ls-files").split("\n");
  assert.ok(tracked.includes(".gsd/phases/01-foo/01-ROADMAP.md"), tracked.join(","));
  assert.ok(!tracked.includes(".gsd/.compat.json"), tracked.join(","));
  assert.ok(!tracked.some((path) => path.startsWith(".gsd/quarantine/")), tracked.join(","));
});
