// Project/App: gsd-pi
// File Purpose: Prompt contract tests for milestone validation verification-class evidence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const promptPath = join(process.cwd(), "src/resources/extensions/gsd/prompts/validate-milestone.md");
const prompt = readFileSync(promptPath, "utf-8");

test("validate-milestone reviewer C requires canonical verification class names", () => {
  assert.match(prompt, /\*\*Reviewer C[\s\S]*Verification Classes/i);
  assert.match(prompt, /must be exactly `Contract`, `Integration`, `Operational`, or `UAT`/i);
  assert.match(prompt, /Preserve every planned non-empty class row/i);
  assert.match(prompt, /first cell of each row must be exactly `Contract`, `Integration`, `Operational`, or `UAT`/i);
  assert.match(prompt, /If no verification classes were planned, say that explicitly/i);
});

test("validate-milestone prompt routes verification class analysis into verificationClasses", () => {
  assert.match(prompt, /pass a complete canonical table in `verificationClasses`/i);
  assert.match(prompt, /If Reviewer C omitted a planned class, reconstruct the missing row/i);
  assert.match(prompt, /Do not call `gsd_validate_milestone` with a partial `verificationClasses` table/i);
});

test("validate-milestone prompt forbids reading phase directories as files", () => {
  assert.match(prompt, /find \.gsd -type f/i);
  assert.match(prompt, /\.gsd\/phases\/<NN>-<slug>\/` is a directory, not an artifact/i);
  assert.match(prompt, /never pass a phase, slice, `tasks\/`, or `slices\/` directory/i);
  assert.doesNotMatch(prompt, /Read a full SUMMARY under `\.gsd\/milestones\/\{\{milestoneId\}\}\/slices\/`/i);
});
