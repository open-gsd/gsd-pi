// Project/App: gsd-pi
// File Purpose: Verifies the new-milestone discuss prompts save milestone CONTEXT through gsd_summary_save.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHARED_VARS = {
  milestoneId: "M001",
  contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
  roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
  commitInstruction: "Commit the created milestone artifacts.",
  multiMilestoneCommitInstruction: "Commit the created milestone artifacts.",
  inlinedTemplates: "## Template\n\nUse standard GSD artifacts.",
};

const PROMPTS: Array<[string, Record<string, string>]> = [
  ["discuss", { preamble: "New project.", preparationContext: "", structuredQuestionsAvailable: "true" }],
  ["discuss-headless", { seedContext: "# Spec\n\nBuild the thing." }],
];

// The discuss handoff never registers a CONTEXT.md file, so a prompt that
// tells the agent to write the file leaves the context out of the database.
for (const [name, vars] of PROMPTS) {
  test(`${name} prompt saves milestone CONTEXT through gsd_summary_save, not a file write`, async (t) => {
    const previousGsdHome = process.env.GSD_HOME;
    const providedGsdHome = process.env.GSD_TEST_HOME;
    const isolatedHome = providedGsdHome ?? mkdtempSync(join(tmpdir(), "gsd-discuss-context-save-"));
    process.env.GSD_HOME = isolatedHome;
    t.after(() => {
      if (previousGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = previousGsdHome;
      if (!providedGsdHome) rmSync(isolatedHome, { recursive: true, force: true });
    });

    const { loadPrompt } = await import(`../prompt-loader.ts?test=${Date.now()}`);
    const prompt: string = loadPrompt(name, { ...SHARED_VARS, ...vars });

    assert.match(
      prompt,
      /4\. Call `gsd_summary_save` with `milestone_id: M001`, `artifact_type: "CONTEXT"`/,
      "single-milestone CONTEXT step must name the tool",
    );
    assert.match(
      prompt,
      /5\. Call `gsd_summary_save` with the primary milestone's `milestone_id`[^\n]*`artifact_type: "CONTEXT"`/,
      "multi-milestone CONTEXT step must name the tool",
    );
    assert.doesNotMatch(
      prompt,
      /\bwrit(e|ten)\b[^\n`]*`[^`\n]*CONTEXT\.md`/i,
      "no step or checklist item may ask for a CONTEXT.md file write",
    );
  });
}
