// Project/App: gsd-pi
// File Purpose: Verifies the guided milestone discussion prompt renders its core interview and persistence contracts.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VISION_ASK_VARIANTS } from "../vision-ask.ts";
import { buildDiscussMilestonePrompt } from "../auto-prompts.ts";

test("guided milestone prompt renders compact interview and context guidance", async (t) => {
  const previousGsdHome = process.env.GSD_HOME;
  const providedGsdHome = process.env.GSD_TEST_HOME;
  const isolatedHome = providedGsdHome ?? mkdtempSync(join(tmpdir(), "gsd-guided-milestone-render-"));
  process.env.GSD_HOME = isolatedHome;
  t.after(() => {
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    if (!providedGsdHome) rmSync(isolatedHome, { recursive: true, force: true });
  });

  const { loadPrompt } = await import(`../prompt-loader.ts?test=${Date.now()}`);
  const prompt = loadPrompt("guided-discuss-milestone", {
    workingDirectory: process.env.GSD_TEST_WORKSPACE_ROOT ?? process.cwd(),
    milestoneId: "M001",
    milestoneTitle: "Baseline And Safety",
    structuredQuestionsAvailable: "true",
    fastPathInstruction: "No fast path in this test.",
    inlinedTemplates: "## Context\n\n## Decisions\n\n## Open Questions",
    commitInstruction: "Do not commit during this test.",
  });

  assert.match(prompt, /M001 context written/);
  assert.match(prompt, /Project Shape/);
  assert.ok(
    VISION_ASK_VARIANTS.some((opener) => prompt.includes(opener)),
    "prompt should render a conversational opener variant",
  );
  assert.doesNotMatch(prompt, /\{\{visionAsk\}\}/);
  assert.match(prompt, /default to `complex`/i);
  assert.match(prompt, /3 or 4 concrete, researched options/);
  assert.match(prompt, /"Other — let me discuss"/);
  assert.match(prompt, /CONTEXT-DRAFT/);
  assert.match(prompt, /Do NOT mention this save to the user/);
  assert.match(prompt, /depth_verification_M001_confirm/);
  assert.match(prompt, /artifact_type: "CONTEXT"/);
  assert.match(prompt, /milestone_id: M001/);
  assert.doesNotMatch(prompt, /\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/);
});

test("guided milestone prompt builder preloads milestone planning context", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-guided-milestone-context-"));
  try {
    const milestonesRoot = join(base, ".gsd", "milestones");
    const priorDir = join(milestonesRoot, "M001");
    const currentDir = join(milestonesRoot, "M002");
    const futureDir = join(milestonesRoot, "M003");
    mkdirSync(priorDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    mkdirSync(futureDir, { recursive: true });

    writeFileSync(join(base, ".gsd", "DECISIONS.md"), "# Decisions\n\nDECISION-SIGNAL", "utf-8");
    writeFileSync(join(priorDir, "M001-SUMMARY.md"), "# M001 Summary\n\nPRIOR-SUMMARY-SIGNAL", "utf-8");
    writeFileSync(join(currentDir, "M002-ROADMAP.md"), "# M002 Roadmap\n\nROADMAP-SIGNAL", "utf-8");
    writeFileSync(join(currentDir, "M002-CONTEXT.md"), "# M002 Context\n\nCONTEXT-SIGNAL", "utf-8");
    writeFileSync(join(currentDir, "M002-RESEARCH.md"), "# M002 Research\n\nRESEARCH-SIGNAL", "utf-8");
    writeFileSync(join(futureDir, "M003-SUMMARY.md"), "# M003 Summary\n\nFUTURE-SUMMARY-SIGNAL", "utf-8");

    const prompt = await buildDiscussMilestonePrompt("M002", "Checkout Polish", base, "true");

    assert.match(prompt, /## Inlined Context \(preloaded — do not re-read these files\)/);
    assert.match(prompt, /### Milestone Roadmap/);
    assert.match(prompt, /ROADMAP-SIGNAL/);
    assert.match(prompt, /### Milestone Context/);
    assert.match(prompt, /CONTEXT-SIGNAL/);
    assert.match(prompt, /### Milestone Research/);
    assert.match(prompt, /RESEARCH-SIGNAL/);
    assert.match(prompt, /### Decisions Register/);
    assert.match(prompt, /DECISION-SIGNAL/);
    assert.match(prompt, /### M001 Prior Milestone Summary/);
    assert.match(prompt, /PRIOR-SUMMARY-SIGNAL/);
    assert.doesNotMatch(prompt, /FUTURE-SUMMARY-SIGNAL/);
    assert.match(prompt, /### Output Template: Context/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("guided milestone prompt builder prepends configured response language", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-guided-milestone-language-"));
  const gsdHome = mkdtempSync(join(tmpdir(), "gsd-guided-milestone-language-home-"));
  const previousGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = gsdHome;

  try {
    writeFileSync(join(gsdHome, "PREFERENCES.md"), "---\nversion: 1\nlanguage: 中文\n---\n", "utf-8");

    const prompt = await buildDiscussMilestonePrompt("M001", "Language Preference", base, "true", {
      includeContextMode: false,
    });

    assert.match(prompt, /^## Response Language\n\nAlways respond in 中文/);
  } finally {
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(base, { recursive: true, force: true });
    rmSync(gsdHome, { recursive: true, force: true });
  }
});

test("guided milestone prompt builder caps prior draft seed before interpolation", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-guided-milestone-draft-cap-"));
  const previousGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = join(base, ".gsd-home");

  try {
    const currentDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(currentDir, { recursive: true });

    const draftPath = join(currentDir, "M001-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Draft\n\nSMALL-DRAFT-SIGNAL", "utf-8");
    const smallPrompt = await buildDiscussMilestonePrompt("M001", "Draft Resume", base, "true", {
      includeContextMode: false,
    });

    writeFileSync(
      draftPath,
      ["# Draft", "", "SMALL-DRAFT-SIGNAL", "", "A".repeat(200_000), "", "OVERSIZED-DRAFT-TAIL-SIGNAL"].join("\n"),
      "utf-8",
    );
    const largePrompt = await buildDiscussMilestonePrompt("M001", "Draft Resume", base, "true", {
      includeContextMode: false,
    });

    const addedChars = largePrompt.length - smallPrompt.length;

    assert.match(largePrompt, /## Prior Discussion \(Draft Seed\)/);
    assert.match(largePrompt, /### Prior Discussion Draft/);
    assert.match(largePrompt, /SMALL-DRAFT-SIGNAL/);
    assert.doesNotMatch(largePrompt, /OVERSIZED-DRAFT-TAIL-SIGNAL/);
    assert.match(
      largePrompt,
      /Draft seed truncated; read the full draft at `\.gsd\/milestones\/M001\/M001-CONTEXT-DRAFT\.md` if needed\./,
    );
    assert.ok(addedChars < 25_000, `large draft should add bounded seed chars, added ${addedChars}`);
  } finally {
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(base, { recursive: true, force: true });
  }
});
