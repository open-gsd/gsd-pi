// gsd-pi / execute-summary-save PROJECT registration hard-fail tests
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { openDatabase, closeDatabase, getAllMilestones, getArtifact } from "../gsd-db.ts";
import { parseProject } from "../schemas/parsers.ts";
import { markApprovalGateVerified, clearDiscussionFlowState } from "../bootstrap/write-gate.ts";
import { executeSummarySave } from "../tools/workflow-tool-executors.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-summary-save-empty-project-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* swallow */ }
}

function openTestDb(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
}

async function inProjectDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

function setupBase(t: { after: (fn: () => void) => void }): string {
  const base = makeTmpBase();
  // Force deep planning so the root-artifact guard requires a verified approval gate,
  // matching the production flow that surfaces the regression.
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  openTestDb(base);
  markApprovalGateVerified("depth_verification_project_confirm", base);
  t.after(() => {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  });
  return base;
}

test("executeSummarySave returns isError when PROJECT.md content has zero parseable milestone lines", async (t) => {
  const base = setupBase(t);

  const content = [
    "# Project",
    "",
    "## What This Is",
    "",
    "Bad-separator regression fixture.",
    "",
    "## Milestone Sequence",
    "",
    // Wrong separator: " : " instead of em-dash / -- / -  → MILESTONE_LINE_RE matches zero lines.
    "- [ ] M001: Foundation : Establish the first runnable slice.",
    "",
    "## Next Section",
    "",
    "Trailing prose with no list bullets so MILESTONE_LINE_RE cannot bridge across lines.",
    "",
  ].join("\n");

  const result = await inProjectDir(base, () => executeSummarySave({
    artifact_type: "PROJECT",
    content,
  }, base));

  assert.equal(result.isError, true);
  assert.equal(result.details.error, "milestone_registration_empty_parse");
  assert.match(result.content[0].text, /zero parseable milestone lines/);
  assert.equal(getAllMilestones().length, 0);
});

test("executeSummarySave registers milestones when PROJECT.md uses canonical em-dash format", async (t) => {
  const base = setupBase(t);

  const content = [
    "# Project",
    "",
    "## What This Is",
    "",
    "Canonical milestone-sequence fixture.",
    "",
    "## Milestone Sequence",
    "",
    "- [ ] M001: Foo — bar",
    "- [ ] M002: Baz — qux",
    "",
  ].join("\n");

  const result = await inProjectDir(base, () => executeSummarySave({
    artifact_type: "PROJECT",
    content,
  }, base));

  assert.notEqual(result.isError, true);
  assert.deepEqual(result.details.registeredMilestones, ["M001", "M002"]);
  assert.equal(getAllMilestones().length, 2);
});

test("executeSummarySave self-heals the Milestone Sequence when DB already has milestones but content parses zero", async (t) => {
  const base = setupBase(t);

  // 1) First save registers M001 as complete; DB now holds the milestone with
  //    authoritative status.
  const canonical = [
    "# Project",
    "",
    "## Milestone Sequence",
    "",
    "<!-- Check off milestones as they complete. -->",
    "",
    "- [x] M001: Foo — bar",
    "",
  ].join("\n");
  await inProjectDir(base, () => executeSummarySave({ artifact_type: "PROJECT", content: canonical }, base));
  assert.equal(getAllMilestones().length, 1);

  // 2) A completion re-save reflows the sequence with an en-dash separator the
  //    canonical parser rejects → zero parseable lines, but the DB is intact.
  //    (A trailing non-bullet section prevents MILESTONE_LINE_RE from bridging
  //    onto a later bullet.) The checkbox here is deliberately WRONG (unchecked)
  //    to prove the rebuild takes status from the DB, not the malformed content.
  const malformed = [
    "# Project",
    "",
    "## Milestone Sequence",
    "",
    "<!-- Check off milestones as they complete. -->",
    "",
    "- [ ] M001: Foo – shipped bar", // en-dash U+2013, not accepted by MILESTONE_LINE_RE
    "",
    "## Notes",
    "",
    "Trailing prose with no list bullets.",
    "",
  ].join("\n");

  const result = await inProjectDir(base, () => executeSummarySave({ artifact_type: "PROJECT", content: malformed }, base));

  // Non-fatal: the save succeeds and reports the self-heal.
  assert.notEqual(result.isError, true);
  assert.equal(result.details.milestoneSequenceSelfHealed, true);
  assert.deepEqual(result.details.registeredMilestones, ["M001"]);
  assert.equal(getAllMilestones().length, 1);

  // The persisted PROJECT.md now parses canonically and preserves status + prose.
  const persisted = getArtifact("PROJECT.md");
  assert.ok(persisted);
  const parsed = parseProject(persisted!.full_content);
  assert.equal(parsed.milestones.length, 1);
  const m001 = parsed.milestones.find(m => m.id === "M001");
  assert.ok(m001);
  // Status comes from the DB (M001 complete), not the unchecked box in the
  // malformed content.
  assert.equal(m001!.done, true);
  assert.equal(m001!.title, "Foo");
  assert.match(m001!.oneLiner, /shipped bar/);
  // The HTML comment hint survives the rebuild.
  assert.match(persisted!.full_content, /Check off milestones as they complete/);
});
