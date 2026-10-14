// Project/App: gsd-pi
// File Purpose: A PROJECT save keeps existing milestone titles and phase dirs, and never registers a done or below-max milestone id as queued.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { closeDatabase, getMilestone, insertMilestone, openDatabase } from "../gsd-db.ts";
import { markApprovalGateVerified, clearDiscussionFlowState } from "../bootstrap/write-gate.ts";
import { canonicalPhaseDirName } from "../paths.ts";
import { executeSummarySave } from "../tools/workflow-tool-executors.ts";
import { seedLifecycle } from "./db-authority-gate.ts";

const TITLES: Record<string, string> = {
  M002: "Billing - Invoices and Payments",
  M003: "Reporting - Monthly Revenue Dashboards",
  M004: "Notifications - Email and Push Delivery",
};

const PROJECT = [
  "# Project",
  "",
  "## Milestone Sequence",
  "",
  "- [x] M001: Foundation — app shell, auth and settings, built before this project used the database.",
  "- [x] M002: Billing — invoices and payments on top of M001.",
  "- [x] M003: Reporting — monthly revenue dashboards.",
  "- [ ] M004: Notifications — email and push delivery. Awaiting sign-off.",
  "- [ ] M005: Search — full-text search across invoices and reports.",
  "",
].join("\n");

function setupBase(t: { after: (fn: () => void) => void }): string {
  const base = join(tmpdir(), `gsd-project-save-sequence-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  openDatabase(join(base, ".gsd", "gsd.db"));
  markApprovalGateVerified("depth_verification_project_confirm", base);
  t.after(() => {
    clearDiscussionFlowState(base);
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

/** A milestone row with an adopted lifecycle, as planning or completion leaves it. */
function seedMilestone(id: string, title: string, completed: boolean): void {
  insertMilestone({ id, title, status: completed ? "complete" : "active" });
  seedLifecycle({ itemKind: "milestone", milestoneId: id, lifecycleStatus: completed ? "completed" : "ready" }, `adopt-${id}`);
}

function seedPhaseDir(base: string, id: string, title: string): string {
  const dir = join(base, ".gsd", "phases", canonicalPhaseDirName(id, title));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-ROADMAP.md"), `# ${title}\n`);
  return dir;
}

async function saveProject(base: string, content: string, t: { after: (fn: () => void) => void }) {
  const originalCwd = process.cwd();
  process.chdir(base);
  t.after(() => process.chdir(originalCwd));
  return executeSummarySave({ artifact_type: "PROJECT", content }, base);
}

test("a PROJECT save keeps existing titles and phase dirs and registers only the new open milestone", async (t) => {
  const base = setupBase(t);
  seedMilestone("M002", TITLES.M002, true);
  seedMilestone("M003", TITLES.M003, true);
  seedMilestone("M004", TITLES.M004, false);
  const dirs = Object.entries(TITLES).map(([id, title]) => seedPhaseDir(base, id, title));
  const dirsBefore = readdirSync(join(base, ".gsd", "phases")).sort();

  const result = await saveProject(base, PROJECT, t);

  assert.notEqual(result.isError, true, result.content[0].text);
  for (const [id, title] of Object.entries(TITLES)) {
    assert.equal(getMilestone(id)?.title, title, `${id} keeps its title; the sequence line's short title does not replace it`);
  }
  assert.equal(getMilestone("M002")?.status, "complete");
  assert.equal(getMilestone("M003")?.status, "complete");
  assert.equal(getMilestone("M005")?.title, "Search", "the new milestone is registered with its line's title");
  assert.equal(getMilestone("M005")?.status, "queued");
  assert.equal(getMilestone("M001"), null, "a done line for a milestone with no row is not registered");
  assert.deepEqual(result.details.registeredMilestones, ["M002", "M003", "M004", "M005"]);
  for (const dir of dirs) assert.equal(existsSync(join(dir, "01-ROADMAP.md")), true, `${dir} is untouched`);
  assert.deepEqual(readdirSync(join(base, ".gsd", "phases")).sort(), dirsBefore, "no phase dir was renamed or created");
});

test("a PROJECT save does not register an open line below the highest existing milestone", async (t) => {
  const base = setupBase(t);
  seedMilestone("M003", "Third", false);
  const content = [
    "# Project",
    "",
    "## Milestone Sequence",
    "",
    "- [ ] M001: Earlier — never planned in this database.",
    "- [ ] M003: Third — the current one.",
    "- [ ] M004: Fourth — next.",
    "",
  ].join("\n");

  const result = await saveProject(base, content, t);

  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(getMilestone("M001"), null);
  assert.equal(getMilestone("M004")?.status, "queued");
  assert.deepEqual(result.details.registeredMilestones, ["M003", "M004"]);
});

test("a PROJECT save still fills an existing milestone's empty title", async (t) => {
  const base = setupBase(t);
  seedMilestone("M001", "", false);
  const content = ["# Project", "", "## Milestone Sequence", "", "- [ ] M001: Foundation — first slice.", ""].join("\n");

  const result = await saveProject(base, content, t);

  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(getMilestone("M001")?.title, "Foundation");
});

test("a first PROJECT save whose every line is done registers nothing and says why", async (t) => {
  const base = setupBase(t);
  const content = ["# Project", "", "## Milestone Sequence", "", "- [x] M001: Legacy — done before.", ""].join("\n");

  const result = await saveProject(base, content, t);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /marked done/);
  assert.equal(getMilestone("M001"), null);
});
