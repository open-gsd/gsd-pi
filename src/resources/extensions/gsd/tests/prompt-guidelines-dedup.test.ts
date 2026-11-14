// gsd-pi — Regression tests: prompt-guidelines dedup contract (#3181 / PR #3182)
// Locks the system-prompt slimming: guidelines carry only behavioral rules,
// hidden aliases are never advertised, and mac-tools guidance is not duplicated
// by the [SYSTEM CONTEXT — Mac Tools] block.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

function extractGuidelines(source: string): string[] {
  return [...source.matchAll(/promptGuidelines:\s*\[([\s\S]*?)\]/g)].map((match) => match[1]);
}

// ─── db-tools: model-facing guidelines never reference hidden aliases ─────────

test("db-tools guidelines never advertise alias-only names (#3181)", () => {
  const source = readRepoFile("src/resources/extensions/gsd/bootstrap/db-tools.ts");
  const guidelines = extractGuidelines(source);
  assert.ok(guidelines.length > 0, "db-tools.ts must define promptGuidelines arrays");

  for (const block of guidelines) {
    assert.ok(!block.includes("is only an alias"), "guidelines must not describe suppressed aliases");
    for (const deadAlias of ["gsd_complete_task", "gsd_complete_slice", "gsd_slice_replan", "gsd_roadmap_reassess", "gsd_milestone_plan", "gsd_slice_plan", "gsd_task_plan"]) {
      assert.ok(!block.includes(deadAlias), `guidelines must not mention hidden alias "${deadAlias}"`);
    }
  }
});

test("db-tools guidelines keep canonical-name pointer for gsd_summary_save (#3181)", () => {
  const source = readRepoFile("src/resources/extensions/gsd/bootstrap/db-tools.ts");
  assert.match(
    source,
    /Use gsd_summary_save for structured project artifacts/,
    "gsd_summary_save guidelines must keep the canonical-name pointer (tool-naming guard)",
  );
});

// ─── system.md persona: single registry, no duplicated tool-name lists ────────

test("system.md persona drops the duplicated macOS tool-name list (#3181)", () => {
  const persona = readRepoFile("src/resources/extensions/gsd/prompts/system.md");
  assert.ok(!persona.includes("macOS tools available"), "persona must not list mac_* names (schema + Mac Tools block expose them)");
  assert.ok(!persona.includes("Commands: `/gsd"), "persona must not inline the /gsd commands registry (## Commands section owns it)");
  assert.match(persona, /^## Commands$/m, "persona must keep the ## Commands registry");
});

test("system.md persona keeps DB guardrails after dedup (#3181)", () => {
  const persona = readRepoFile("src/resources/extensions/gsd/prompts/system.md");
  assert.match(persona, /Never query.*\.gsd\/gsd\.db.*directly/i, "DB guardrail must survive dedup");
  assert.match(persona, /single-writer WAL/i, "WAL guardrail must survive dedup");
});

test("system.md hard rules no longer self-reference base Guidelines (#3181)", () => {
  const persona = readRepoFile("src/resources/extensions/gsd/prompts/system.md");
  assert.ok(
    !persona.includes("base Guidelines already cover"),
    "Hard Rules must not restate base guidelines that the prompt pipeline dedupes",
  );
});

// ─── mac-tools: per-tool guidance kept, context-block duplication removed ─────

test("mac-tools guidelines no longer duplicate the Mac Tools context block (#3181)", () => {
  const source = readRepoFile("src/resources/extensions/mac-tools/index.ts");
  const guidelines = extractGuidelines(source);
  assert.ok(guidelines.length > 0, "mac-tools must define promptGuidelines arrays");

  const duplicatedPhrases = [
    "permission error",
    "mac_get_tree instead",
    "visual verification",
    "Screen Recording permission",
    "Prefer mac_find search mode",
    "Verify the click worked",
    "Use mac_find first to discover",
  ];
  for (const block of guidelines) {
    for (const phrase of duplicatedPhrases) {
      assert.ok(!block.includes(phrase), `mac guidelines must not duplicate context-block phrase "${phrase}"`);
    }
  }
});

test("mac-tools keeps per-tool specifics that the context block does not cover (#3181)", () => {
  const source = readRepoFile("src/resources/extensions/mac-tools/index.ts");
  const joined = extractGuidelines(source).join("\n");
  for (const kept of ["mode:focused", "AXTextArea", "windowId", "bundleId", "retina"]) {
    assert.ok(joined.includes(kept), `mac guidelines must keep per-tool specificity "${kept}"`);
  }
});

test("Mac Tools context block is still owned by the mac-tools extension (#3181)", () => {
  const source = readRepoFile("src/resources/extensions/mac-tools/index.ts");
  assert.match(source, /Native macOS App Interaction/, "mac-tools must keep the Mac Tools context block");
  assert.match(source, /discover → act → verify|discover→act→verify/i, "Mac Tools block must own the discover→act→verify guidance");
});
