import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildCompleteMilestonePrompt, buildPlanMilestonePrompt } from "../auto-prompts.ts";
import { createWorkspace, scopeMilestone } from "../workspace.ts";
import { getUnitToolSurfaceContract } from "../unit-tool-contracts.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" },
  }).trim();
}

function makeRepo(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-right-size-"));
  git(base, ["init", "-b", "main"]);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# Context\n\nTest milestone.");
  for (const [path, content] of Object.entries(files)) {
    const abs = join(base, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  git(base, ["add", "."]);
  git(base, ["commit", "-m", "init"]);
  return base;
}

function writeCompleteMilestoneFiles(base: string, validation: string): void {
  const dir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(join(dir, "slices", "S01"), { recursive: true });
  writeFileSync(join(dir, "M001-ROADMAP.md"), "# M001\n\n## Slices\n- [x] **S01: One** `risk:low` `depends:[]`\n  > Done\n");
  writeFileSync(join(dir, "M001-VALIDATION.md"), validation);
  writeFileSync(join(dir, "slices", "S01", "S01-SUMMARY.md"), "# S01 Summary\n\n**Verification:** passed\n");
  // Post-cutover the closer prompt enumerates the milestone's slices from the
  // DB, and the set of current artifacts the validation receipt must cover is
  // derived from that list. Without the row, S01's SUMMARY is not a "current
  // artifact" and every coverage check passes vacuously.
  seedSliceRows();
}

/** Seed the M001/S01 rows `buildCompleteMilestonePrompt` reads. */
function seedSliceRows(): void {
  openDatabase(":memory:");
  if (!isDbAvailable()) throw new Error("fixture must have an open DB");
  insertMilestone({ id: "M001", title: "Polish static page", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "One", status: "complete", risk: "low", depends: [], sequence: 1 });
}

function cleanupRepo(base: string): void {
  try { closeDatabase(); } catch { /* no DB open for this fixture */ }
  rmSync(base, { recursive: true, force: true });
}

function validationMetadata(): string {
  return [
    "validation_metadata:",
    "  covered_artifacts:",
    "    - `.gsd/milestones/M001/M001-VALIDATION.md`",
    "    - `.gsd/milestones/M001/M001-ROADMAP.md`",
    "    - `.gsd/milestones/M001/slices/S01/S01-SUMMARY.md`",
  ].join("\n");
}

test("plan-milestone prompt includes tiny untyped project classification and one-slice guidance", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    const prompt = await buildPlanMilestonePrompt("M001", "Polish static page", base, scopeMilestone(createWorkspace(base), "M001"), "minimal");
    assert.match(prompt, /\*\*Kind:\*\* untyped-existing/);
    assert.match(prompt, /\*\*Content files:\*\* 1/);
    assert.match(prompt, /`index\.html`/);
    assert.match(prompt, /Prefer exactly one slice/);
  } finally {
    cleanupRepo(base);
  }
});

test("plan-milestone prompt references only lifecycle tools allowed by its unit contract", async (t) => {
  const base = makeRepo({ "hello.py": "print('hello')\n" });
  t.after(() => cleanupRepo(base));
  const prompt = await buildPlanMilestonePrompt(
    "M001",
    "Add hello command",
    base,
    scopeMilestone(createWorkspace(base), "M001"),
    "minimal",
  );
  const allowed = new Set<string>(getUnitToolSurfaceContract("plan-milestone")?.allowedGsdTools ?? []);
  const referenced = new Set(
    Array.from(prompt.matchAll(/\b(gsd_[a-z0-9_]+)\b/gu), (match) => match[1]!),
  );

  assert.ok(referenced.size > 0, "rendered prompt should name its persistence tools");
  for (const toolName of referenced) {
    assert.ok(allowed.has(toolName), `rendered plan-milestone prompt must allow ${toolName}`);
  }
  assert.doesNotMatch(prompt, /\bgsd_(?:resume|exec|exec_search)\b/);
});

test("plan-milestone prompt includes small untyped project 1-2 slice guidance", async () => {
  const base = makeRepo({
    "index.html": "html",
    "README.md": "readme",
    "styles.css": "body {}",
  });
  try {
    const prompt = await buildPlanMilestonePrompt("M001", "Polish static files", base, scopeMilestone(createWorkspace(base), "M001"), "minimal");
    assert.match(prompt, /\*\*Kind:\*\* untyped-existing/);
    assert.match(prompt, /\*\*Content files:\*\* 3/);
    assert.match(prompt, /Prefer 1-2 slices/);
  } finally {
    cleanupRepo(base);
  }
});

test("plan-milestone prompt keeps normal guidance for typed projects", async () => {
  const base = makeRepo({
    "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n",
    "src/index.js": "console.log('ok');\n",
  });
  try {
    const prompt = await buildPlanMilestonePrompt("M001", "Update app", base, scopeMilestone(createWorkspace(base), "M001"), "minimal");
    assert.match(prompt, /\*\*Kind:\*\* typed-existing/);
    assert.match(prompt, /Use normal ecosystem-aware planning guidance/);
    assert.doesNotMatch(prompt, /Prefer exactly one slice/);
  } finally {
    cleanupRepo(base);
  }
});

test("plan-milestone standard prompt keeps project and decisions on-demand", async () => {
  const base = makeRepo({
    "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n",
    "src/index.js": "console.log('ok');\n",
    ".gsd/PROJECT.md": "# Project\n\nPlan broad project body.\n",
    ".gsd/REQUIREMENTS.md": "# Requirements\n\nPlan requirement body.\n",
    ".gsd/DECISIONS.md": "# Decisions\n\nPlan decision body.\n",
  });
  try {
    const prompt = await buildPlanMilestonePrompt("M001", "Update app", base, scopeMilestone(createWorkspace(base), "M001"), "standard");
    assert.match(prompt, /### On-demand Planning Context/);
    assert.match(prompt, /`\.gsd\/PROJECT\.md`/);
    assert.match(prompt, /`\.gsd\/DECISIONS\.md`/);
    assert.match(prompt, /Plan requirement body/);
    assert.doesNotMatch(prompt, /Plan broad project body/);
    assert.doesNotMatch(prompt, /Plan decision body/);
  } finally {
    cleanupRepo(base);
  }
});

test("plan-milestone resolves Project artifacts from a canonical milestone worktree", async () => {
  const base = makeRepo({
    "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n",
    ".gsd/PROJECT.md": "# Project\n\nCanonical project context.\n",
    ".gsd/REQUIREMENTS.md": "# Requirements\n\nCanonical requirements.\n",
    ".gsd/DECISIONS.md": "# Decisions\n\nCanonical decisions.\n",
  });
  const worktree = join(base, ".gsd-worktrees", "M001");
  git(base, ["worktree", "add", "--detach", worktree, "HEAD"]);
  rmSync(join(worktree, ".gsd"), { recursive: true, force: true });

  try {
    const projectRoadmap = "../../.gsd/milestones/M001/M001-ROADMAP.md";

    for (const level of ["standard", "full"] as const) {
      const prompt = await buildPlanMilestonePrompt("M001", "Update app", worktree, scopeMilestone(createWorkspace(worktree), "M001"), level);

      assert.match(prompt, /Project state root: `\.\.\/\.\.\/\.gsd`/);
      assert.match(prompt, /`\.\.\/\.\.\/\.gsd\/PROJECT\.md`/);
      assert.match(prompt, /`\.\.\/\.\.\/\.gsd\/REQUIREMENTS\.md`/);
      assert.match(prompt, /`\.\.\/\.\.\/\.gsd\/DECISIONS\.md`/);
      assert.match(prompt, /Source: `\.\.\/\.\.\/\.gsd\/milestones\/M001\/M001-CONTEXT\.md`/);
      assert.ok(prompt.includes(projectRoadmap), "roadmap output should target Project state through a worktree-relative path");
      assert.doesNotMatch(prompt, /`\.gsd\/(?:PROJECT|REQUIREMENTS|DECISIONS)\.md`/);
      assert.ok(!prompt.includes(join(worktree, ".gsd")), "prompt must not reference a worktree-local .gsd directory");
    }
  } finally {
    git(base, ["worktree", "remove", "--force", worktree]);
    cleanupRepo(base);
  }
});

test("workflow docs no longer contain blanket 4-10 slice guidance", () => {
  const docs = readFileSync(join(process.cwd(), "src", "resources", "GSD-WORKFLOW.md"), "utf-8");
  assert.doesNotMatch(docs, /4-10 slices/);
  assert.match(docs, /1-10 slices/);
  assert.match(docs, /single-file/);
});

test("prompt templates carry right-sized planning and closeout mode guidance", () => {
  const planTemplate = readFileSync(join(process.cwd(), "src", "resources", "extensions", "gsd", "prompts", "plan-milestone.md"), "utf-8");
  const completeTemplate = readFileSync(join(process.cwd(), "src", "resources", "extensions", "gsd", "prompts", "complete-milestone.md"), "utf-8");

  assert.match(planTemplate, /Use 1-10 slices, sized to the work/);
  assert.match(planTemplate, /tiny\/single-file\/static work should usually be one slice/);
  assert.match(planTemplate, /untyped-existing/);
  assert.match(completeTemplate, /Closeout Review Mode/);
  assert.match(completeTemplate, /Follow the current DB-backed validation status/);
  assert.doesNotMatch(completeTemplate, /^### Delegate Review Work/m);
});

test("complete-milestone prompt trusts passing validation artifact", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, `---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\n${validationMetadata()}\n\nAll checks passed.`);
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Passing Validation Artifact/);
    assert.match(prompt, /the current database receipt remains authoritative/);
    assert.match(prompt, /Do not delegate fresh reviewer\/security\/tester audits/);
    assert.match(prompt, /All checks passed/);
  } finally {
    cleanupRepo(base);
  }
});

test("complete-milestone prompt trusts centralized markdown body pass verdict", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, `# Validation\n\n**Verdict:** PASS\n\n${validationMetadata()}\n\nAll checks passed.`);
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Passing Validation Artifact/);
    assert.match(prompt, /the current database receipt remains authoritative/);
    assert.match(prompt, /Do not delegate fresh reviewer\/security\/tester audits/);
  } finally {
    cleanupRepo(base);
  }
});

test("complete-milestone prompt does not trust stale pass validation without metadata", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nAll checks passed.");
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Validation Requires Attention/);
    assert.match(prompt, /missing freshness metadata/);
    assert.doesNotMatch(prompt, /Passing Validation Artifact/);
  } finally {
    cleanupRepo(base);
  }
});

test("complete-milestone prompt does not trust pass validation missing current summary coverage", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, [
      "---",
      "verdict: pass",
      "remediation_round: 0",
      "---",
      "",
      "# Validation",
      "validation_metadata:",
      "  covered_artifacts:",
      "    - `.gsd/milestones/M001/M001-VALIDATION.md`",
      "    - `.gsd/milestones/M001/M001-ROADMAP.md`",
      "",
      "All checks passed.",
    ].join("\n"));
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Validation Requires Attention/);
    assert.match(prompt, /does not cover current milestone artifacts/);
    assert.doesNotMatch(prompt, /Passing Validation Artifact/);
  } finally {
    cleanupRepo(base);
  }
});

test("complete-milestone prompt keeps deeper review path without passing validation", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, "---\nverdict: needs-attention\nremediation_round: 0\n---\n\n# Validation\nFix gaps.");
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Validation Requires Attention/);
    assert.match(prompt, /verdict `needs-attention`/);
    assert.match(prompt, /Use `subagent` for review work needing fresh context/i);
  } finally {
    cleanupRepo(base);
  }
});
