// gsd-pi - /gsd migrate Preview approval tests.
// File Purpose: Prove that /gsd migrate applies only the Import Preview whose hash the operator approved.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

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

test("/gsd migrate without --preview prints the Preview hash and applies nothing", async (t) => {
  const base = makePlanningProject(t);
  const { ctx, notes } = makeCtx();

  await handleMigrate(base, ctx, pi);

  const preview = notes.at(-1);
  assert.equal(preview?.kind, "warning", preview?.message);
  assert.match(preview?.message ?? "", /Preview hash: sha256:[0-9a-f]{64}/u);
  assert.match(preview?.message ?? "", /create milestone:M001/u);
  assert.match(preview?.message ?? "", /Nothing was written\. To apply this exact Preview, run: \/gsd migrate --preview=sha256:[0-9a-f]{64} /u);
  assert.equal(milestoneCount(), 0);
  assert.equal(importApplicationCount(), 0);
  assert.deepEqual(projectionFiles(base), []);
  assert.deepEqual(
    readdirSync(base).sort(),
    [".gsd", ".planning"],
    "no backup and no staging directory is left in the project",
  );
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
    _getAdapter()!.prepare("SELECT preview_hash FROM workflow_import_applications").all(),
    [{ preview_hash: approval.slice("--preview=".length) }],
    "the Import Application is the approved Preview",
  );
  assert.ok(projectionFiles(base).some((path) => path.endsWith("-ROADMAP.md")));

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
  assert.equal(milestoneCount(), 0);
  assert.equal(importApplicationCount(), 0);
  assert.deepEqual(projectionFiles(base), []);
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
  assert.deepEqual(
    _getAdapter()!.prepare("SELECT preview_hash FROM workflow_import_applications").all(),
    [{ preview_hash: sealed.previewHash }],
  );
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
