// Project/App: gsd-pi
// File Purpose: ADR-046 fault gate (projection non-authority). A changed
// projection file never stops dispatch: the Projection Worker keeps one copy
// of the changed bytes, renders the database content again, and reports it.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { saveRequirementToDb } from "../db-writer.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  describePreservedProjectionChanges,
  preserveProjectionChangesBeforeDispatch,
  rebuildMarkdownProjectionsFromDb,
  repairProjectionDrift,
} from "../projection-worker.ts";
import { invalidateStateCache } from "../state.ts";
import { reconcileBeforeDispatch } from "../state-reconciliation/index.ts";
import { poisonProjections, snapshotProjections, snapshotWorkflowTables } from "./db-authority-gate.ts";
import { createWorkflowAuthorityFixture, type WorkflowAuthorityFixture } from "./workflow-authority-fixture.ts";

let fixture: WorkflowAuthorityFixture;

afterEach(() => {
  fixture?.cleanup();
  invalidateStateCache();
});

const QUARANTINE = `${sep}quarantine${sep}`;

/** Managed projection files outside quarantine, by path. */
function liveProjections(base: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshotProjections(base)).filter(([path]) => !path.includes(QUARANTINE)),
  );
}

/** Content of every quarantine copy of the `.gsd`-relative file. */
function quarantineCopies(base: string, gsdRelativePath: string): string[] {
  const root = join(base, ".gsd", "quarantine", "projections");
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((entry) => entry.split(sep).slice(1).join("/") === `gsd/${gsdRelativePath}`)
    .map((entry) => readFileSync(join(root, entry), "utf-8"));
}

test("G2: poisoned projections before dispatch are rendered again and never stop dispatch", async () => {
  fixture = await createWorkflowAuthorityFixture();
  const base = fixture.root;
  assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);
  const control = liveProjections(base);
  const tablesBefore = snapshotWorkflowTables();

  poisonProjections(base);
  const poisoned = liveProjections(base);
  // STATE.md is derived on every render and has no model to compare with; it is checked on its own below.
  const statePath = Object.keys(control).find((path) => path.endsWith(`${sep}STATE.md`));
  assert.ok(statePath, "the control render includes STATE.md");
  const changed = Object.keys(control).filter((path) => path !== statePath && poisoned[path] !== control[path]);
  for (const name of ["01-ROADMAP.md", "01-02-PLAN.md", "REQUIREMENTS.md"]) {
    assert.ok(changed.some((path) => path.endsWith(`${sep}${name}`)), `the fixture poisons ${name}`);
  }

  // The pre-dispatch sequence of the auto orchestrator and the spawn gate.
  const observation = await preserveProjectionChangesBeforeDispatch(base);
  const reconciled = await reconcileBeforeDispatch(base);
  const drift = await repairProjectionDrift(base);

  assert.deepEqual(observation.held, []);
  assert.deepEqual(observation.errors, []);
  assert.deepEqual(drift.errors, []);
  assert.deepEqual(reconciled.blockers, [], "no dispatch stops");
  assert.deepEqual(snapshotWorkflowTables(), tablesBefore, "a poisoned file writes no workflow row");

  const after = liveProjections(base);
  const notice = describePreservedProjectionChanges(base, observation.preserved);
  const gsdRoot = join(Object.keys(control)[0]!.split(`${sep}.gsd${sep}`)[0]!, ".gsd");
  for (const path of changed) {
    const rel = relative(gsdRoot, path).split(sep).join("/");
    assert.equal(after[path], control[path], `${rel} is back to the database render`);
    assert.deepEqual(quarantineCopies(base, rel), [poisoned[path]], `${rel} has one quarantine copy`);
    assert.equal(notice.split(`.gsd/${rel} -> `).length, 2, `${rel} is in the user notice once`);
  }
  assert.equal(after[statePath], control[statePath], "STATE.md is back to the database render");
});

describe("external state layout: .gsd is a symlink to the state directory", () => {
  let project: string;
  let state: string;

  beforeEach(() => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-external-project-")));
    state = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-external-state-")));
    symlinkSync(state, join(project, ".gsd"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(openDatabase(join(project, ".gsd", "gsd.db")), true);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(project, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  const requirement = (description: string) => ({
    class: "core-capability",
    status: "active",
    description,
    why: "The state directory is outside the project.",
    source: "projection-never-blocks",
    primary_owner: "M001/S01",
    validation: "The hand edit is kept.",
  });
  const handEdit = "# Requirements\n\nEdited by hand.\n";

  test("a GSD write through the real path keeps one copy of a hand edit", async () => {
    await saveRequirementToDb(requirement("First requirement"), project);
    writeFileSync(join(state, "REQUIREMENTS.md"), handEdit);

    await saveRequirementToDb(requirement("Second requirement"), project);

    assert.match(readFileSync(join(state, "REQUIREMENTS.md"), "utf-8"), /Second requirement/);
    assert.deepEqual(quarantineCopies(project, "REQUIREMENTS.md"), [handEdit]);
  });

  test("the Projection Worker keeps one copy of a hand edit, renders the file again, and names the copy", async () => {
    await saveRequirementToDb(requirement("First requirement"), project);
    const rendered = readFileSync(join(state, "REQUIREMENTS.md"), "utf-8");
    writeFileSync(join(state, "REQUIREMENTS.md"), handEdit);

    const observation = await preserveProjectionChangesBeforeDispatch(project);

    assert.deepEqual(observation.errors, []);
    assert.equal(readFileSync(join(state, "REQUIREMENTS.md"), "utf-8"), rendered);
    assert.deepEqual(quarantineCopies(project, "REQUIREMENTS.md"), [handEdit]);
    assert.match(
      describePreservedProjectionChanges(project, observation.preserved),
      /REQUIREMENTS\.md -> .*quarantine\/projections\/[^\n]*\/gsd\/REQUIREMENTS\.md/,
    );
  });
});
