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

test("validate-milestone prompt requires structured verificationEvidence for every planned class", () => {
  assert.match(prompt, /never authorizes validation/i);
  assert.match(prompt, /needs at least one current `verificationEvidence` entry/i);
  assert.match(prompt, /planned \.\.\. verification requires current structured database evidence/i);
  assert.match(prompt, /add a canonical `UAT` row to the `verificationClasses` table AND at least one UAT evidence entry/i);
  assert.match(prompt, /verificationClasses must include canonical row "UAT"/i);
});

test("validate-milestone prompt states the one-evidence-class invariant and uniform UAT browser shapes", () => {
  assert.match(prompt, /All entries for each required verification class must share a single `evidenceClass`/i);
  assert.match(prompt, /verification evidence must use one evidence class/i);
  assert.match(prompt, /every UAT entry uses `evidenceClass: "browser"`/i);
  assert.match(prompt, /`commandOrTool` runs `gsd_uat_exec`/i);
});

test("validate-milestone prompt gates browser evidence on a pass verdict and honest slice binding", () => {
  assert.match(prompt, /browser evidence gate runs only when the verdict is `pass`/i);
  assert.match(prompt, /persist the honest failure/i);
  assert.match(prompt, /the UAT row and entry are still required/i);
  assert.match(prompt, /bound to that slice's ID/i);
  assert.match(prompt, /bind each entry to the slice its evidence was actually produced for/i);
  assert.match(prompt, /bound to every browser-required Slice/i);
  assert.match(prompt, /milestone itself \(not its slices\) requires browser acceptance/i);
  assert.match(prompt, /without a slice binding is enough/i);
  assert.doesNotMatch(prompt, /does not match the slice the evidence was produced for/i);
});

test("validate-milestone prompt distinguishes a label correction from a changed source", () => {
  assert.match(prompt, /formatted `sha256:<hex>`/i);
  assert.match(prompt, /computes for a new validation attempt/i);
  assert.match(prompt, /only the recorded label is wrong/i);
  assert.match(prompt, /copy the `sha256:\.\.\.` value from the error message into `testedSourceRevision` on EVERY evidence entry/i);
  assert.match(prompt, /only the first stale entry is reported/i);
  assert.match(prompt, /do not relabel: re-produce the evidence/i);
  assert.match(prompt, /against the current source/i);
});

test("validate-milestone prompt forbids reading phase directories as files", () => {
  assert.match(prompt, /find \.gsd -type f/i);
  assert.match(prompt, /\.gsd\/phases\/<NN>-<slug>\/` is a directory, not an artifact/i);
  assert.match(prompt, /never pass a phase, slice, `tasks\/`, or `slices\/` directory/i);
  assert.doesNotMatch(prompt, /Read a full SUMMARY under `\.gsd\/milestones\/\{\{milestoneId\}\}\/slices\/`/i);
});
