import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSourceRegion } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("dispatchNewMilestoneDiscuss uses discuss.md only on greenfield projects", () => {
  const source = readFileSync(join(__dirname, "..", "guided-flow.ts"), "utf-8");
  const fnBody = extractSourceRegion(source, "async function dispatchNewMilestoneDiscuss(");

  assert.match(fnBody, /findMilestoneIds\(basePath\)\.length === 0/);
  assert.match(fnBody, /prepareAndBuildDiscussPrompt/);
  assert.match(fnBody, /buildDiscussMilestonePrompt/);
  assert.match(
    fnBody,
    /if \(isGreenfield\)[\s\S]*prepareAndBuildDiscussPrompt[\s\S]*buildDiscussMilestonePrompt/,
    "greenfield branch must precede guided-discuss-milestone branch",
  );
});

test("dispatchNewMilestoneDiscuss uses milestone-specific preparation guidance", () => {
  const source = readFileSync(join(__dirname, "..", "guided-flow.ts"), "utf-8");
  const fnBody = extractSourceRegion(source, "async function dispatchNewMilestoneDiscuss(");
  assert.match(fnBody, /buildDiscussPreparationContext\(ctx, basePath, "milestone", true\)/);
});

test("launchNextMilestoneDiscuss routes through dispatchNewMilestoneDiscuss for normal path", () => {
  const source = readFileSync(join(__dirname, "..", "guided-flow.ts"), "utf-8");
  const fnBody = extractSourceRegion(source, "export async function launchNextMilestoneDiscuss(");

  assert.match(fnBody, /dispatchNewMilestoneDiscuss/);
  assert.doesNotMatch(
    fnBody,
    /await dispatchWorkflow\([\s\S]*prepareAndBuildDiscussPrompt/,
    "launchNextMilestoneDiscuss should not call prepareAndBuildDiscussPrompt directly",
  );
});
