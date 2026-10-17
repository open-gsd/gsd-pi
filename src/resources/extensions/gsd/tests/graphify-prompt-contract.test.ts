// Project/App: gsd-pi
// File Purpose: Prompt contract tests for the graphify freshness and edge-semantics guidance.

import test from "node:test";
import assert from "node:assert/strict";
import { loadPrompt } from "../prompt-loader.ts";

function renderGraphifyPrompt(action: string): string {
  return loadPrompt("graphify", { action });
}

test("graphify status freshness covers working-tree state, not just HEAD movement", () => {
  const prompt = renderGraphifyPrompt("status");
  assert.match(prompt, /HEAD moved since the last build/);
  assert.match(prompt, /git status --porcelain/);
  assert.match(prompt, /git diff --name-only <last build commit>/);
  assert.match(prompt, /uncommitted or untracked changes/);
});

test("graphify status counts newly added source files as graph-relevant", () => {
  const prompt = renderGraphifyPrompt("status");
  assert.match(prompt, /newly added source files/);
  assert.match(prompt, /not in the graph yet/);
});

test("graphify status reports dirty-tree builds and unknown coverage honestly", () => {
  const prompt = renderGraphifyPrompt("status");
  assert.match(prompt, /freshness as unknown/);
  assert.match(prompt, /was built from a dirty tree/);
});

test("graphify build stamps dirty-tree provenance and keeps the previous valid graph pair on failure", () => {
  const prompt = renderGraphifyPrompt("build");
  assert.match(prompt, /noting whether the working tree was dirty or had untracked sources at build time/);
  assert.match(prompt, /Prepare both files before writing either/);
  assert.match(prompt, /keep the previous pair rather than leaving a partial graph/);
});

test("graphify edge semantics distinguish imports from calls and static from runtime evidence", () => {
  const prompt = renderGraphifyPrompt("build");
  assert.match(prompt, /an `import` alone is not a `calls` edge/);
  assert.match(prompt, /`calls` requires an actual call site as evidence/);
  assert.match(prompt, /static source facts, not runtime evidence/);
});
