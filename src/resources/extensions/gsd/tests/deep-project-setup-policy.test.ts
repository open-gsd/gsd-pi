import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  resolveDeepProjectSetupState,
} from "../deep-project-setup-policy.ts";
import { closeDatabase, insertArtifact, openDatabase } from "../gsd-db.ts";
import type { GSDPreferences } from "../preferences.ts";
import { recordResearchDecision, recordWorkflowPreferencesCaptured } from "../project-setup-facts.ts";

const deepPrefs = { planning_depth: "deep" } as GSDPreferences;

const validProject = readFileSync(
  new URL("../schemas/__fixtures__/valid-project.md", import.meta.url),
  "utf-8",
);
const validRequirements = readFileSync(
  new URL("../schemas/__fixtures__/valid-requirements.md", import.meta.url),
  "utf-8",
);

let base: string;

beforeEach(() => {
  base = join(tmpdir(), `gsd-deep-policy-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
});

afterEach(() => {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
});

function saveRootArtifact(path: "PROJECT.md" | "REQUIREMENTS.md", content: string): void {
  insertArtifact({
    path,
    artifact_type: path.replace(".md", ""),
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: content,
  });
}

function saveReadyProject(): void {
  recordWorkflowPreferencesCaptured();
  saveRootArtifact("PROJECT.md", validProject);
  saveRootArtifact("REQUIREMENTS.md", validRequirements);
}

function writeResearchFiles(names: string[]): void {
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of names) {
    writeFileSync(join(base, ".gsd", "research", name), "# research\n");
  }
}

const ALL_DIMENSION_BLOCKERS = ["STACK", "FEATURES", "ARCHITECTURE", "PITFALLS"].map((d) => `${d}-BLOCKER.md`);

function resolved(): { status: string; stage: string | null } {
  const { status, stage } = resolveDeepProjectSetupState(deepPrefs, base);
  return { status, stage };
}

test("deep setup policy: skip decision wins over stale research blockers", () => {
  saveReadyProject();
  recordResearchDecision("skip");
  writeResearchFiles(ALL_DIMENSION_BLOCKERS);

  assert.deepEqual(resolved(), { status: "complete", stage: null });
});

test("deep setup policy: no recorded research decision means skip", () => {
  saveReadyProject();
  writeResearchFiles(ALL_DIMENSION_BLOCKERS);

  assert.deepEqual(resolved(), { status: "complete", stage: null });
});

test("deep setup policy: a research decision can dispatch, block, or complete", () => {
  saveReadyProject();
  recordResearchDecision("research");
  assert.deepEqual(resolved(), { status: "pending", stage: "project-research" });

  writeResearchFiles(ALL_DIMENSION_BLOCKERS);
  assert.deepEqual(resolved(), { status: "blocked", stage: "project-research" });

  rmSync(join(base, ".gsd", "research"), { recursive: true, force: true });
  writeResearchFiles(["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS-BLOCKER.md"]);
  assert.deepEqual(resolved(), { status: "complete", stage: null });
});

test("resolveDeepProjectSetupState: saved PROJECT and REQUIREMENTS imply the workflow preferences stage, and nothing is written", () => {
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  saveRootArtifact("PROJECT.md", validProject);
  saveRootArtifact("REQUIREMENTS.md", validRequirements);

  assert.deepEqual(resolved(), { status: "complete", stage: null });
  assert.equal(readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8"), "---\nplanning_depth: deep\n---\n");
  assert.equal(existsSync(join(base, ".gsd", "runtime")), false);
});

test("resolveDeepProjectSetupState: still pending when the PROJECT stage is not saved", () => {
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n");

  assert.deepEqual(resolved(), { status: "pending", stage: "workflow-preferences" });

  recordWorkflowPreferencesCaptured();
  assert.deepEqual(resolved(), { status: "pending", stage: "project" });
});
