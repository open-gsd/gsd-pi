// #2996 — the validate-milestone tool rejects any evidence entry whose
// testedSourceRevision differs from the aggregate source snapshot it computes,
// but the prompt never stated that value: the first validation call on any
// milestone had to fail on a placeholder (typically sha256:0000) before the
// agent could copy the real revision out of the mismatch error — and that
// forced failure is the last red error the operator sees under Validate
// Milestone. The prompt now carries the current source revision, computed at
// prompt-build time with the same reader the tool uses.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildValidateMilestonePrompt } from "../auto-prompts.ts";
import { captureMilestoneVerificationSourceRevision } from "../verification-source-integrity.ts";
import { openDatabase, closeDatabase, insertMilestone } from "../gsd-db.ts";
import { makeTempRepo } from "./test-utils.ts";

const promptPath = join(process.cwd(), "src/resources/extensions/gsd/prompts/validate-milestone.md");

test("validate-milestone template states the prefilled source revision and forbids placeholders", () => {
  const prompt = readFileSync(promptPath, "utf-8");
  assert.match(prompt, /When this prompt was built, the current source revision was `\{\{currentSourceRevision\}\}`/);
  assert.match(prompt, /never invent a placeholder such as `sha256:0000`/);
});

test("buildValidateMilestonePrompt renders the enforced source revision into the prompt", async (t) => {
  const base = makeTempRepo("gsd-validate-prompt-revision-");
  const savedCwd = process.cwd();
  process.chdir(base);
  t.after(() => {
    try { closeDatabase(); } catch { /* best-effort */ }
    process.chdir(savedCwd);
    rmSync(base, { recursive: true, force: true });
  });

  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Validated milestone", status: "active" });

  const source = captureMilestoneVerificationSourceRevision(base, undefined);
  assert.ok(source.ok, `source snapshot must compute: ${source.ok ? "" : source.error}`);
  if (!source.ok) return;

  const prompt = await buildValidateMilestonePrompt("M001", "Validated milestone", base);

  assert.match(
    prompt,
    new RegExp(`When this prompt was built, the current source revision was \\\`${source.sourceRevision.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\\``),
    "the prompt must carry the exact revision the tool will enforce",
  );
  // The template's own guidance names sha256:0000 as the placeholder never
  // to invent — assert no actual revision value uses a zero placeholder.
  const placeholderAsValue = prompt.match(/revision[^\n]*`sha256:0+`/);
  assert.equal(
    placeholderAsValue === null || /never invent a placeholder/.test(placeholderAsValue[0]),
    true,
    `no placeholder revision may be used as a value: ${placeholderAsValue?.[0] ?? ""}`,
  );
});
