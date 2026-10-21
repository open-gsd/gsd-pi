// gsd-pi — #4780: slice-summary excerpts replace full inlining in
// buildCompleteMilestonePrompt. Verify (a) the excerpt helper emits
// frontmatter fields + section heads + on-demand path, (b) the closer
// prompt lists all slice SUMMARY paths under "On-demand Slice Summaries",
// (c) regression on prompt size.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSliceSummaryExcerpt, buildCompleteMilestonePrompt, buildValidateMilestonePrompt } from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  insertGateRow,
  insertMilestone,
  insertSlice,
  openDatabase,
  saveGateResult,
} from "../gsd-db.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-cm-excerpt-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  // Fixtures that seed slice rows open a DB under `base`; close it before the
  // directory goes away so the next test starts from a clean singleton.
  try { closeDatabase(); } catch { /* no DB open for this fixture */ }
  rmSync(base, { recursive: true, force: true });
}

/**
 * Seed the slice rows the closer/validate prompt builders read. Post-cutover
 * the slice list comes from `getMilestoneSlices` only, so the ROADMAP written
 * alongside is projection context; these rows are what drives excerpt inlining
 * and the "On-demand Slice Summaries" path list.
 */
function seedRoadmapSlices(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Excerpt helper", status: "complete", risk: "medium", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Closer wiring", status: "complete", risk: "low", depends: ["S01"], sequence: 2 });
}

function writeRoadmap(base: string, content: string): void {
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), content);
}

function writeSummary(base: string, sid: string, content: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", sid, `${sid}-SUMMARY.md`),
    content,
  );
}

function writeAssessment(base: string, sid: string, content: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", sid, `${sid}-ASSESSMENT.md`),
    content,
  );
}

// A summary with enough body narrative that full inlining would balloon the
// prompt. The excerpt should keep frontmatter + sections but drop the
// "What Happened" narrative.
function makeFatSummary(sid: string): string {
  const narrativePara =
    "The team discovered several subtle integration issues, traced them to the cache layer, and produced a patch set that threads the cache key through every call site. ".repeat(20);
  return [
    "---",
    `id: ${sid}`,
    "parent: M001",
    "milestone: M001",
    "provides:",
    "  - compact slice-summary excerpts",
    "  - on-demand read path registry",
    "affects:",
    "  - complete-milestone prompt builder",
    "key_decisions:",
    "  - use parseSummary for frontmatter extraction",
    "  - fall back to full inline when frontmatter fails",
    "patterns_established:",
    "  - excerpt-first inlining for closer units",
    "key_files:",
    "  - src/resources/extensions/gsd/auto-prompts.ts",
    "duration: 1h",
    "verification_result: passed",
    "completed_at: 2026-04-24",
    "blocker_discovered: false",
    "---",
    "",
    `# ${sid}: Slice summary`,
    "**Short one-liner for the slice**",
    "",
    "## What Happened",
    "",
    narrativePara,
    "",
    "## Deviations",
    "",
    "Extended the excerpt helper scope at review time.",
    "",
    "## Known Limitations",
    "",
    "Does not yet cover validate-milestone — follow-up.",
    "",
    "## Follow-ups",
    "",
    "- Wire the same excerpt into buildValidateMilestonePrompt",
  ].join("\n");
}

function makeRoadmap(): string {
  return [
    "# M001 Roadmap",
    "## Slices",
    "- [x] **S01: Excerpt helper** `risk:medium` `depends:[]`",
    "- [x] **S02: Closer wiring** `risk:low` `depends:[S01]`",
  ].join("\n");
}

// ─── buildSliceSummaryExcerpt unit tests ──────────────────────────────────

test("#4780 excerpt: emits compact block with frontmatter fields + section heads", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  const absPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  const relPath = ".gsd/milestones/M001/slices/S01/S01-SUMMARY.md";
  writeSummary(base, "S01", makeFatSummary("S01"));

  const out = await buildSliceSummaryExcerpt(absPath, relPath, "S01");

  // Compact header with source path for on-demand Read
  assert.match(out, /### S01 Summary \(excerpt\)/);
  assert.match(out, /Source: `\.gsd\/milestones\/M001\/slices\/S01\/S01-SUMMARY\.md`/);

  // Frontmatter fields surfaced
  assert.match(out, /\*\*Title:\*\* S01: Slice summary/);
  assert.match(out, /\*\*One-liner:\*\*/);
  assert.match(out, /\*\*Verification:\*\* `passed`/);
  assert.match(out, /\*\*Blockers:\*\* none/);
  assert.match(out, /\*\*Provides:\*\* compact slice-summary excerpts;/);
  assert.match(out, /\*\*Key decisions:\*\* use parseSummary/);
  assert.match(out, /\*\*Patterns established:\*\* excerpt-first inlining/);

  // Section heads included (body-section markdown), not whole sections inlined
  assert.match(out, /#### Deviations/);
  assert.match(out, /#### Known limitations/);
  assert.match(out, /#### Follow-ups/);

  // On-demand instruction present
  assert.match(out, /On-demand.*read.*for the full "What Happened"/);

  // Bulk narrative is NOT inlined — excerpt is meaningfully shorter than full
  // A 20x-repeated paragraph produces ~2.5KB; excerpt should come in well under.
  const fullSize = makeFatSummary("S01").length;
  assert.ok(
    out.length < fullSize * 0.6,
    `excerpt length ${out.length} should be < 60% of full summary length ${fullSize}`,
  );
});

test("#4780 excerpt: blocker_discovered=true surfaces prominent marker", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  const content = [
    "---",
    "id: S01",
    "parent: M001",
    "milestone: M001",
    "blocker_discovered: true",
    "---",
    "# S01",
    "**One-liner**",
    "",
    "## What Happened",
    "content",
  ].join("\n");
  const absPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  writeSummary(base, "S01", content);

  const out = await buildSliceSummaryExcerpt(absPath, "rel", "S01");
  assert.match(out, /Blockers:\*\* ⚠️ blocker recorded/);
});

test("#4780 excerpt: fall back to full inline when frontmatter is unrecognizable", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  // No frontmatter, no id — parser returns empty id, triggering fallback
  const garbage = "# S99\n\nJust a wall of text with no frontmatter at all.\n";
  const absPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S99-SUMMARY.md");
  writeFileSync(absPath, garbage);

  const out = await buildSliceSummaryExcerpt(absPath, "rel/path.md", "S99");
  // Full content preserved (no excerpt wrapper), no data-loss
  assert.match(out, /Just a wall of text/);
  assert.match(out, /### S99 Summary/);
});

test("#4780 excerpt: missing file reports not-found fallback", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));

  const out = await buildSliceSummaryExcerpt(null, "rel/missing.md", "S42");
  assert.match(out, /### S42 Summary \(excerpt\)/);
  assert.match(out, /not found — file does not exist yet/);
});

test("#4780 excerpt: section bodies are capped", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  // Long Follow-ups section (~4.8KB) would balloon the excerpt without
  // the cap — regression coverage for #4908.
  const longFollowUps = "A verbose follow-up bullet that keeps restating the same point. ".repeat(60);
  const content = [
    "---",
    "id: S01",
    "parent: M001",
    "milestone: M001",
    "---",
    "# S01: Test",
    "**One-liner**",
    "",
    "## Follow-ups",
    longFollowUps,
  ].join("\n");
  const absPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  writeSummary(base, "S01", content);

  const out = await buildSliceSummaryExcerpt(absPath, "rel/path.md", "S01");

  assert.match(out, /\(truncated — see full `rel\/path\.md`\)/);
  assert.ok(
    out.length < 2000,
    `excerpt length ${out.length} should be well under 2KB when one section hits the cap`,
  );
});

// ─── buildCompleteMilestonePrompt integration test ─────────────────────────

test("#4780 closer prompt: uses excerpts + lists on-demand slice SUMMARY paths", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  writeRoadmap(base, makeRoadmap());
  seedRoadmapSlices(base);
  writeSummary(base, "S01", makeFatSummary("S01"));
  writeSummary(base, "S02", makeFatSummary("S02"));
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n\nBroad product context should stay on-demand.");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# Context\n\nMilestone context should stay on-demand.");

  const prompt = await buildCompleteMilestonePrompt("M001", "Test Milestone", base);

  // Excerpt markers present for each slice
  assert.match(prompt, /### S01 Summary \(excerpt\)/);
  assert.match(prompt, /### S02 Summary \(excerpt\)/);

  // On-demand path section exists with both slice paths
  assert.match(prompt, /### On-demand Slice Summaries/);
  assert.match(prompt, /S01-SUMMARY\.md/);
  assert.match(prompt, /S02-SUMMARY\.md/);
  assert.match(prompt, /### On-demand Project Context/);
  assert.match(prompt, /### On-demand Milestone Context/);
  assert.ok(
    !prompt.includes("Broad product context should stay on-demand."),
    "standard complete-milestone prompt should not inline project narrative",
  );
  assert.ok(
    !prompt.includes("Milestone context should stay on-demand."),
    "standard complete-milestone prompt should not inline milestone context narrative",
  );

  // Fat narrative (the 20x-repeated paragraph) is NOT inlined
  assert.ok(
    !prompt.includes("threads the cache key through every call site."),
    "closer prompt must not inline full 'What Happened' narrative after #4780",
  );

  // Prompt size is bounded — the two fat summaries' narratives alone would
  // have exceeded ~4KB each. Post-fix closer prompt should be meaningfully
  // smaller than their combined raw size.
  const rawSize = makeFatSummary("S01").length + makeFatSummary("S02").length;
  // Prompt includes roadmap, templates, and other inlines, so it may still
  // be sizable — the guard is specifically that the fat narrative is gone.
  // Use a soft bound: prompt - overhead should be less than 2x one summary.
  assert.ok(
    prompt.length < rawSize + 20_000,
    `closer prompt length ${prompt.length} should be < raw summary size ${rawSize} + 20KB headroom`,
  );
});

test("complete-milestone prompt caps repeated inlined context around 20k chars", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  writeRoadmap(base, makeRoadmap());
  seedRoadmapSlices(base);
  writeSummary(base, "S01", makeFatSummary("S01"));
  writeSummary(base, "S02", makeFatSummary("S02"));
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
    "# M001 Context\n\n" + "Large milestone context body. ".repeat(1200),
  );
  writeFileSync(
    join(base, ".gsd", "KNOWLEDGE.md"),
    "# Project Knowledge\n\n## Patterns\n\n### Test Milestone shared\n" + "Large scoped knowledge body. ".repeat(1200),
  );

  const prompt = await buildCompleteMilestonePrompt("M001", "Test Milestone", base);
  const contextStart = prompt.indexOf("## Inlined Context (preloaded");
  const contextEnd = prompt.indexOf("## Steps", contextStart);
  assert.ok(contextStart >= 0, "prompt should include inlined context");
  assert.ok(contextEnd > contextStart, "prompt should include steps after inlined context");

  const inlinedContext = prompt.slice(contextStart, contextEnd);
  assert.ok(
    inlinedContext.length <= 21_000,
    `inlined context ${inlinedContext.length} chars should stay near the 20k cap`,
  );
});

test("validate-milestone prompt uses slice excerpts and on-demand paths instead of full prior artifacts", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  writeRoadmap(base, makeRoadmap());
  seedRoadmapSlices(base);
  writeSummary(base, "S01", makeFatSummary("S01"));
  writeSummary(base, "S02", makeFatSummary("S02"));
  writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n\nBroad validation product context should stay on-demand.");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# Context\n\nValidation milestone context should stay on-demand.");
  writeAssessment(
    base,
    "S01",
    [
      "# Assessment",
      "",
      "Verdict: PASS — 15 checks passed across runtime simulation.",
      "",
      "## Edge Cases",
      "Empty query, no matches, and priority sort all pass.",
      "",
      "## Full Runtime Trace",
      "This very noisy assessment trace should stay out of the prompt. ".repeat(80),
    ].join("\n"),
  );

  const prompt = await buildValidateMilestonePrompt("M001", "Test Milestone", base);

  assert.match(prompt, /### S01 Summary \(excerpt\)/);
  assert.match(prompt, /### S02 Summary \(excerpt\)/);
  assert.match(prompt, /### S01 Assessment \(excerpt\)/);
  assert.match(prompt, /### On-demand Validation Artifacts/);
  assert.match(prompt, /### On-demand Project Context/);
  assert.match(prompt, /### On-demand Milestone Context/);
  assert.match(prompt, /S01-SUMMARY\.md/);
  assert.match(prompt, /S01-ASSESSMENT\.md/);
  assert.ok(
    !prompt.includes("Broad validation product context should stay on-demand."),
    "standard validate-milestone prompt should not inline project narrative",
  );
  assert.ok(
    !prompt.includes("Validation milestone context should stay on-demand."),
    "standard validate-milestone prompt should not inline milestone context narrative",
  );
  assert.ok(
    !prompt.includes("threads the cache key through every call site."),
    "validate prompt must not inline full slice summary narrative",
  );
  assert.ok(
    !prompt.includes("This very noisy assessment trace should stay out of the prompt."),
    "validate prompt must not inline full assessment traces",
  );
});

test("validate-milestone emits failure-aware reviewer instructions", async (t) => {
  const base = createBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();
  writeRoadmap(base, makeRoadmap());
  seedRoadmapSlices(base);
  writeSummary(base, "S01", makeFatSummary("S01"));
  writeSummary(base, "S02", makeFatSummary("S02"));

  const prompt = await buildValidateMilestonePrompt("M001", "Test Milestone", base);

  assert.match(prompt, /evaluate only the declared boundaries/i);
  assert.match(prompt, /transitive dependency chains are valid/i);
  assert.match(prompt, /ASSESSMENT records `FAIL`.*return `FAIL`/i);
  assert.match(prompt, /Any FAIL -> `needs-remediation`[\s\S]*Otherwise, any NEEDS-ATTENTION/i);
});

test("validate-milestone prompt inlines persisted slice-level Q3/Q4 gate flags", async (t) => {
  const base = createBase();
  t.after(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    cleanup(base);
  });
  invalidateAllCaches();

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Risky Slice", status: "complete" });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q8", scope: "slice" });
  saveGateResult({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "Q3",
    verdict: "flag",
    rationale: "New callback boundary.",
    findings: "Re-check token exposure in the web callback.",
  });
  saveGateResult({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "Q4",
    verdict: "flag",
    rationale: "Requirement touched but not re-tested.",
    findings: "R012 must be re-tested; revisit decision D-3.",
  });
  saveGateResult({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "Q8",
    verdict: "flag",
    rationale: "Operational readiness gap.",
    findings: "Operational finding should not be milestone validation input.",
  });
  writeRoadmap(base, makeRoadmap());
  writeSummary(base, "S01", makeFatSummary("S01"));

  const prompt = await buildValidateMilestonePrompt("M001", "Test Milestone", base);

  assert.match(prompt, /### Persisted Slice-Level Gate Flags \(from quality_gates\)/);
  assert.match(prompt, /S01 \/ Q3 \(Threat Surface\) \/ flag/);
  assert.match(prompt, /Re-check token exposure in the web callback\./);
  assert.match(prompt, /S01 \/ Q4 \(Requirement Impact\) \/ flag/);
  assert.match(prompt, /R012 must be re-tested; revisit decision D-3\./);
  assert.ok(
    !prompt.includes("Operational finding should not be milestone validation input."),
    "validate-milestone should not inline unrelated Q8 gate findings",
  );
});

test("validate-milestone prompt inlines planned verification classes as canonical rows", async (t) => {
  const base = createBase();
  t.after(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    cleanup(base);
  });
  invalidateAllCaches();

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({
    id: "M001",
    planning: {
      verificationContract: "Local command exits 0.",
      verificationOperational: "No long-running child process remains.",
    },
  });
  writeRoadmap(base, makeRoadmap());
  seedRoadmapSlices(base);
  writeSummary(base, "S01", makeFatSummary("S01"));
  writeSummary(base, "S02", makeFatSummary("S02"));

  const prompt = await buildValidateMilestonePrompt("M001", "Test Milestone", base);

  assert.match(prompt, /### Verification Classes \(from planning\)/);
  assert.match(prompt, /Every row in this table must appear in `verificationClasses`/);
  assert.match(prompt, /\| Class \| Planned Check \|/);
  assert.match(prompt, /\| Contract \| Local command exits 0\. \|/);
  assert.match(prompt, /\| Operational \| No long-running child process remains\. \|/);
});
