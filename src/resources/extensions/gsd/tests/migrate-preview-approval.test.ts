// gsd-pi - /gsd migrate Preview approval tests.
// File Purpose: Prove that /gsd migrate applies only the Import Preview whose hash the operator approved.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { handleRecover } from "../commands-maintenance.ts";
import { getWorkflowDatabasePath, isWorkflowDatabaseOpen, openWorkflowDatabase } from "../db-workspace.ts";
import { detectProjectState } from "../detection.ts";
import { _getAdapter, closeDatabase } from "../gsd-db.ts";
import { handleMigrate, parseMigrationRecoveryArgs } from "../migrate/command.ts";
import { executeMigrationWrite, previewMigrationWrite } from "../migrate/execution.ts";
import { createMigrationPlan } from "../migrate/plan.ts";

interface Note {
  message: string;
  kind: string;
}

function makePlanningProject(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-migrate-approval-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  const planning = join(base, ".planning");
  const phase = join(planning, "phases", "29-auth-system");
  mkdirSync(phase, { recursive: true });
  writeFileSync(join(planning, "PROJECT.md"), "# Legacy Project\n\nA project to migrate.\n");
  writeFileSync(join(planning, "ROADMAP.md"), [
    "# Project Roadmap",
    "",
    "## Phases",
    "",
    "- [ ] 29 — Auth System",
    "",
  ].join("\n"));
  writeFileSync(join(phase, "29-01-PLAN.md"), [
    "---",
    'phase: "29-auth-system"',
    'plan: "01"',
    "---",
    "",
    "# 29-01: Implement Auth",
    "",
    "<objective>",
    "Build the authentication system.",
    "</objective>",
    "",
    "<tasks>",
    "<task>Create auth middleware</task>",
    "</tasks>",
    "",
  ].join("\n"));
  return base;
}

// A command context with no interactive menu, as in a headless run.
function makeCtx(): { ctx: Parameters<typeof handleMigrate>[1]; notes: Note[] } {
  const notes: Note[] = [];
  const ctx = {
    hasUI: false,
    ui: { notify: (message: string, kind: string) => { notes.push({ message, kind }); } },
  } as unknown as Parameters<typeof handleMigrate>[1];
  return { ctx, notes };
}

const pi = { sendMessage: () => assert.fail("the review is not offered without an interactive menu") } as unknown as Parameters<typeof handleMigrate>[2];

function milestoneCount(): number {
  return Number(_getAdapter()?.prepare("SELECT COUNT(*) AS count FROM milestones").get()?.["count"] ?? 0);
}

function importApplicationCount(): number {
  return Number(
    _getAdapter()?.prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"] ?? 0,
  );
}

/** The files of the target .gsd, without the database files. */
function projectionFiles(base: string): string[] {
  const root = join(base, ".gsd");
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[])
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => !/^gsd\.db/u.test(entry))
    .sort();
}

test("/gsd migrate without --preview prints the Preview hash and leaves the project a v1 project", async (t) => {
  const base = makePlanningProject(t);
  const { ctx, notes } = makeCtx();
  const before = readdirSync(base, { recursive: true }).sort();

  await handleMigrate(base, ctx, pi);

  const preview = notes.at(-1);
  assert.equal(preview?.kind, "warning", preview?.message);
  assert.match(preview?.message ?? "", /Preview hash: sha256:[0-9a-f]{64}/u);
  assert.match(preview?.message ?? "", /create milestone:M001/u);
  assert.match(preview?.message ?? "", /Nothing was imported\. To apply this exact Preview, run: \/gsd migrate --preview=sha256:[0-9a-f]{64} /u);
  assert.equal(detectProjectState(base).state, "v1-planning", "the guided flow still offers the migration");
  assert.deepEqual(
    readdirSync(base, { recursive: true }).sort(),
    before,
    "the target is as it was: no .gsd, no database, no backup and no staging directory",
  );
  assert.deepEqual(readdirSync(base), [".planning"]);
  assert.equal(isWorkflowDatabaseOpen(), false, "the temporary Preview database is closed");

  // The approval hash does not hold the identity of the temporary database, so it does not change.
  const again = makeCtx();
  await handleMigrate(base, again.ctx, pi);
  const hash = /Preview hash: (sha256:[0-9a-f]{64})/u;
  assert.equal(hash.exec(again.notes.at(-1)?.message ?? "")?.[1], hash.exec(preview?.message ?? "")?.[1]);
  assert.doesNotMatch(again.notes.at(-1)?.message ?? "", /already exists/u, "no existing .gsd is reported");
});

test("/gsd migrate --preview=<hash> applies the Preview that the first run printed", async (t) => {
  const base = makePlanningProject(t);
  const first = makeCtx();
  await handleMigrate(base, first.ctx, pi);
  const approval = /--preview=sha256:[0-9a-f]{64}/u.exec(first.notes.at(-1)?.message ?? "")?.[0];
  assert.ok(approval, first.notes.at(-1)?.message);

  const second = makeCtx();
  await handleMigrate(`${approval} ${JSON.stringify(base)}`, second.ctx, pi);

  assert.match(second.notes.at(-1)?.message ?? "", /Migration complete/u, JSON.stringify(second.notes));
  assert.equal(milestoneCount(), 1);
  assert.deepEqual(
    _getAdapter()!.prepare(
      "SELECT operation.trace_id FROM workflow_import_applications JOIN workflow_operations operation USING (operation_id)",
    ).all(),
    [{ trace_id: approval.slice("--preview=".length) }],
    "the one Import Application records the approved Preview hash",
  );
  assert.ok(projectionFiles(base).some((path) => path.endsWith("-ROADMAP.md")));
  assert.equal(existsSync(join(base, ".gsd-backups")), false, "a target with no .gsd has nothing to back up");

  // The same approval replays the retained migration and applies no second import.
  const third = makeCtx();
  await handleMigrate(`${approval} ${JSON.stringify(base)}`, third.ctx, pi);
  assert.match(third.notes.at(-1)?.message ?? "", /Migration complete/u, JSON.stringify(third.notes));
  assert.equal(importApplicationCount(), 1);
});

test("/gsd migrate refuses a --preview hash that is not the current Preview and applies nothing", async (t) => {
  const base = makePlanningProject(t);
  const first = makeCtx();
  await handleMigrate(base, first.ctx, pi);
  const approval = /--preview=sha256:[0-9a-f]{64}/u.exec(first.notes.at(-1)?.message ?? "")?.[0];
  assert.ok(approval, first.notes.at(-1)?.message);
  // The source changes after the operator read the Preview.
  writeFileSync(join(base, ".planning", "PROJECT.md"), "# Legacy Project\n\nA changed project text.\n");

  const second = makeCtx();
  await handleMigrate(`${approval} ${JSON.stringify(base)}`, second.ctx, pi);

  assert.equal(second.notes.at(-1)?.kind, "error", JSON.stringify(second.notes));
  assert.match(second.notes.at(-1)?.message ?? "", /is not the current Preview; nothing was written/u);
  assert.equal(detectProjectState(base).state, "v1-planning");
  assert.equal(existsSync(join(base, ".gsd")), false);
});

test("/gsd migrate that applies nothing closes the database it opened beside planned projections", async (t) => {
  const base = makePlanningProject(t);
  const milestone = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestone, { recursive: true });
  writeFileSync(join(milestone, "M001-ROADMAP.md"), [
    "# M001: Earlier Work",
    "",
    "## Slices",
    "",
    "- [ ] **S01: First Slice** `risk:low` `depends:[]`",
    "  > Demo for S01",
    "",
  ].join("\n"));
  assert.equal(openWorkflowDatabase(base).reason, "authority-missing", "the fixture has projections and no database");
  const before = readdirSync(base, { recursive: true }).sort();

  // Preview only.
  const first = makeCtx();
  await handleMigrate(base, first.ctx, pi);
  assert.match(first.notes.at(-1)?.message ?? "", /Preview hash: sha256:[0-9a-f]{64}/u, JSON.stringify(first.notes));
  assert.deepEqual(readdirSync(base, { recursive: true }).sort(), before, "a Preview creates no database in the target .gsd");
  assert.equal(existsSync(join(base, ".gsd", "gsd.db")), false);
  assert.equal(isWorkflowDatabaseOpen(), false);
  assert.equal(openWorkflowDatabase(base).reason, "authority-missing", "a Preview does not admit the empty database");

  // A refused hash.
  const second = makeCtx();
  await handleMigrate(`--preview=sha256:${"0".repeat(64)} ${JSON.stringify(base)}`, second.ctx, pi);
  assert.match(second.notes.at(-1)?.message ?? "", /is not the current Preview/u, JSON.stringify(second.notes));
  assert.deepEqual(readdirSync(base, { recursive: true }).sort(), before, "a refused approval creates no database");
  assert.equal(openWorkflowDatabase(base).reason, "authority-missing", "a refused approval does not admit the empty database");

  // The approval of the Preview that the first run printed applies on the new database.
  const approval = /--preview=sha256:[0-9a-f]{64}/u.exec(first.notes.at(-1)?.message ?? "")?.[0];
  const third = makeCtx();
  await handleMigrate(`${approval} ${JSON.stringify(base)}`, third.ctx, pi);
  assert.match(third.notes.at(-1)?.message ?? "", /Migration complete/u, JSON.stringify(third.notes));
  assert.equal(importApplicationCount(), 1);
});

test("the migration write refuses a Preview hash that is not the sealed Preview before the Import Application", async (t) => {
  const base = makePlanningProject(t);
  const plan = await createMigrationPlan(base);
  assert.equal(plan.status, "ready");
  if (plan.status !== "ready") return;

  await assert.rejects(
    () => executeMigrationWrite(
      plan.sourcePath, plan.targetRoot, plan.project, plan.preview, undefined, [], `sha256:${"0".repeat(64)}`,
    ),
    /is not the approved Preview/u,
  );
  assert.equal(milestoneCount(), 0);
  assert.equal(importApplicationCount(), 0);

  // The same migration continues with the hash of its sealed Preview.
  const sealed = await previewMigrationWrite(plan.sourcePath, plan.targetRoot, plan.project);
  await executeMigrationWrite(
    plan.sourcePath, plan.targetRoot, plan.project, plan.preview, undefined, [], sealed.previewHash,
  );
  assert.equal(milestoneCount(), 1);
  assert.equal(importApplicationCount(), 1);
});

test("/gsd migrate Preview leaves the database of the session open", async (t) => {
  const base = makePlanningProject(t);
  mkdirSync(join(base, ".gsd"));
  assert.equal(openWorkflowDatabase(base).ok, true);
  const sessionDatabase = getWorkflowDatabasePath();
  assert.ok(sessionDatabase);

  // Preview only.
  const first = makeCtx();
  await handleMigrate(base, first.ctx, pi);
  assert.match(first.notes.at(-1)?.message ?? "", /Preview hash: sha256:[0-9a-f]{64}/u, JSON.stringify(first.notes));
  assert.equal(isWorkflowDatabaseOpen(), true);
  assert.equal(getWorkflowDatabasePath(), sessionDatabase);

  // A refused hash.
  const second = makeCtx();
  await handleMigrate(`--preview=sha256:${"0".repeat(64)} ${JSON.stringify(base)}`, second.ctx, pi);
  assert.match(second.notes.at(-1)?.message ?? "", /is not the current Preview/u, JSON.stringify(second.notes));
  assert.equal(isWorkflowDatabaseOpen(), true);
  assert.equal(getWorkflowDatabasePath(), sessionDatabase);
  assert.equal(milestoneCount(), 0);
});

test("/gsd recover after /gsd migrate keeps one artifact row for each milestone CONTEXT and RESEARCH", async (t) => {
  const base = makePlanningProject(t);
  mkdirSync(join(base, ".planning", "research"));
  writeFileSync(join(base, ".planning", "research", "SUMMARY.md"), "# Research\n\nWhat the codebase does today.\n");
  const first = makeCtx();
  await handleMigrate(base, first.ctx, pi);
  const approval = /--preview=sha256:[0-9a-f]{64}/u.exec(first.notes.at(-1)?.message ?? "")?.[0];
  assert.ok(approval, first.notes.at(-1)?.message);
  const migrated = makeCtx();
  await handleMigrate(`${approval} ${JSON.stringify(base)}`, migrated.ctx, pi);
  assert.match(migrated.notes.at(-1)?.message ?? "", /Migration complete/u, JSON.stringify(migrated.notes));
  const narrativeRows = () => _getAdapter()!.prepare(
    "SELECT path, full_content FROM artifacts WHERE artifact_type IN ('CONTEXT', 'RESEARCH') AND slice_id IS NULL ORDER BY path",
  ).all();
  const before = narrativeRows();
  assert.deepEqual(
    before.map((row) => row["path"]),
    [".gsd/milestones/M001/M001-CONTEXT.md", ".gsd/milestones/M001/M001-RESEARCH.md"],
    "the fixture has the two documents under the key that migrate stores",
  );

  // The generated slice plan needs the reviewed choice that keeps it preserved.
  const unresolved = makeCtx();
  await handleRecover(unresolved.ctx as never, base);
  const choices = (unresolved.notes.at(-1)?.message ?? "").match(/--choice=sha256:[0-9a-f]{64}\.preserved/gu)?.join(" ") ?? "";

  const preview = makeCtx();
  await handleRecover(preview.ctx as never, base, choices);
  const text = preview.notes.at(-1)?.message ?? "";
  assert.doesNotMatch(text, /artifact:\S*M001-(?:CONTEXT|RESEARCH)\.md/u, "the Preview changes no CONTEXT or RESEARCH row");
  const recoverApproval = /--preview=sha256:[0-9a-f]{64}/u.exec(text)?.[0];
  assert.ok(recoverApproval, text);

  const applied = makeCtx();
  await handleRecover(applied.ctx as never, base, `${recoverApproval} ${choices}`);
  assert.equal(applied.notes.at(-1)?.kind, "success", applied.notes.at(-1)?.message);
  assert.deepEqual(narrativeRows(), before);
});

test("migration arguments accept one well-formed --preview hash only", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(parseMigrationRecoveryArgs(`--preview=${hash} "/tmp/legacy planning"`), {
    sourceArgs: "/tmp/legacy planning",
    choices: [],
    approvedPreviewHash: hash,
  });
  assert.equal(parseMigrationRecoveryArgs("/tmp/legacy").approvedPreviewHash, undefined);
  assert.throws(() => parseMigrationRecoveryArgs("--preview=abc /tmp/legacy"), /Preview hash/u);
  assert.throws(() => parseMigrationRecoveryArgs(`--preview=${hash} --preview=${hash} /tmp/legacy`), /Preview hash/u);
});
