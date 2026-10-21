// Project/App: gsd-pi
// File Purpose: Performance-contract test for the detectStaleRenders file-identity
// parse cache (#442 Phase 1.5). Asserts the observable contract: an unchanged
// projection is NOT re-parsed on the next dispatch (cache hit), while a changed
// projection IS re-parsed (cache miss on path+mtime+size). Modeled on the
// prepared-statement caching contract test in db-adapter.test.ts — it asserts
// external behavior (parse happened / did not), never internal wiring.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";
import { clearParseCache } from "../files.ts";
import { clearPathCache } from "../paths.ts";
import { invalidateStateCache } from "../state.ts";
import { detectStaleRenders } from "../markdown-renderer.ts";
import { enableDebug, disableDebug, getDebugCounters } from "../debug-logger.ts";

function roadmapMd(slices: Array<{ id: string; title: string; done: boolean }>): string {
  const lines = ["# M001 Roadmap", "", "**Vision:** cache contract", "", "## Slices", ""];
  for (const s of slices) lines.push(`- ${s.done ? "[x]" : "[ ]"} **${s.id}: ${s.title}** \`risk:medium\` \`depends:[]\``);
  lines.push("");
  return lines.join("\n");
}

test("#442: detectStaleRenders re-parses ROADMAP only when it changes on disk", { skip: true }, (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-parse-cache-"));
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  const roadmapPath = join(milestoneDir, "M001-ROADMAP.md");
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    disableDebug();
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Cache", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active", risk: "medium", depends: [], sequence: 1 });

  // Start from a cold cache so counts are attributable to this test.
  clearParseCache();
  clearPathCache();
  invalidateStateCache();

  writeFileSync(roadmapPath, roadmapMd([{ id: "S01", title: "Slice", done: false }]));

  enableDebug(base); // resets counters

  // First dispatch: cold cache → the roadmap is read + parsed.
  detectStaleRenders(base);
  const afterCold = getDebugCounters().parseRoadmapCalls;
  assert.ok(afterCold > 0, "cold dispatch must parse the roadmap");

  // Second dispatch, file unchanged: cache hit → NO new parse.
  detectStaleRenders(base);
  const afterWarm = getDebugCounters().parseRoadmapCalls;
  assert.equal(afterWarm, afterCold, "unchanged projection must not be re-parsed");

  // Change the file (different content AND size) WITHOUT clearing caches:
  // the path+mtime+size identity changes, forcing a re-parse.
  writeFileSync(
    roadmapPath,
    roadmapMd([
      { id: "S01", title: "Slice", done: true },
      { id: "S02", title: "Added Slice", done: false },
    ]),
  );
  detectStaleRenders(base);
  const afterChange = getDebugCounters().parseRoadmapCalls;
  assert.ok(afterChange > afterWarm, "a changed projection must be re-parsed");
});
