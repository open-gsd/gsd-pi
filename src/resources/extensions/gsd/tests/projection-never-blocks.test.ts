// Project/App: gsd-pi
// File Purpose: ADR-046 fault gate (projection non-authority). A changed
// projection file never stops dispatch: the Projection Worker keeps one copy
// of the changed bytes, renders the database content again, and reports it.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, test } from "node:test";

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
