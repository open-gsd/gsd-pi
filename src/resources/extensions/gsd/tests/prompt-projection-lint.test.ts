// Project/App: gsd-pi
// File Purpose: Lint every rendered prompt: no managed projection as a write target, no unregistered gsd tool.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrompt } from "../prompt-loader.ts";
import { blockedWriteReason } from "../write-intercept.ts";
import { WORKFLOW_TOOL_SURFACE_NAMES } from "../workflow-tool-surface.ts";
import { registerDbTools } from "../bootstrap/db-tools.ts";
import { registerExecTools } from "../bootstrap/exec-tools.ts";
import { registerJournalTools } from "../bootstrap/journal-tools.ts";
import { registerMemoryTools } from "../bootstrap/memory-tools.ts";
import { registerQueryTools } from "../bootstrap/query-tools.ts";
import { shouldBlockPlanningUnit, shouldBlockQueueExecution } from "../bootstrap/write-gate.ts";
import { resolveManifest } from "../unit-context-manifest.ts";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const promptNames = readdirSync(promptsDir).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3));

const PROJECTION_KINDS = ["CONTEXT", "ROADMAP", "REPLAN", "PLAN", "SUMMARY", "RESEARCH", "VALIDATION", "UAT"];

// Quick tasks keep their summary under .gsd/quick/, outside the managed tree.
const UNMANAGED_PATHS: Record<string, string> = { summaryPath: ".gsd/quick/1-fix-typo/1-SUMMARY.md" };

/** A value for a template variable: a real projection path for path variables. */
function valueFor(name: string): string {
  if (name in UNMANAGED_PATHS) return UNMANAGED_PATHS[name];
  if (!name.endsWith("Path")) return `<${name}>`;
  if (/uatResult/i.test(name)) return ".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md";
  const kind = PROJECTION_KINDS.find((candidate) => name.toUpperCase().includes(candidate));
  return kind ? `.gsd/milestones/M001/M001-${kind}.md` : `<${name}>`;
}

/** Render a prompt through the loader; the loader reports the variables it needs. */
function render(name: string): string {
  try {
    return loadPrompt(name);
  } catch (err) {
    const declared = [...(err as Error).message.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)].map((match) => match[1]);
    assert.ok(declared.length > 0, `loadPrompt("${name}") failed: ${(err as Error).message}`);
    return loadPrompt(name, Object.fromEntries(declared.map((variable) => [variable, valueFor(variable)])));
  }
}

function registeredToolNames(): Set<string> {
  const names = new Set<string>(WORKFLOW_TOOL_SURFACE_NAMES);
  const pi = { registerTool(tool: { name: string }) { names.add(tool.name); } } as any;
  registerDbTools(pi);
  registerExecTools(pi);
  registerJournalTools(pi);
  registerMemoryTools(pi);
  registerQueryTools(pi);
  return names;
}

/** True when the write guard refuses this file name or path. */
function isGuardedProjection(token: string): boolean {
  const candidates = token.includes("/")
    ? [token]
    : [`.gsd/${token}`, `.gsd/milestones/M001/${token}`, `.gsd/milestones/M001/M001-${token}`];
  return candidates.some((candidate) => blockedWriteReason(candidate) !== null);
}

const WRITE_VERB = /\b(?:write|append|edit|update|overwrite|rewrite|create|delete|remove)\b/i;
const NEGATION = /\b(?:not|never|cannot|don't|without|instead of)\b/i;

/** Clauses that tell the agent to write a file the write guard refuses. */
function projectionWriteInstructions(rendered: string): string[] {
  const offenders: string[] = [];
  for (const clause of rendered.split(/\n|(?<=[.;:!?])\s|\s—\s/)) {
    for (const match of clause.matchAll(/[\w#{}<>./-]*[\w#{}<>-]\.md\b/g)) {
      const before = clause.slice(0, match.index);
      const verb = WRITE_VERB.exec(before);
      if (!verb || NEGATION.test(before)) continue;
      if (isGuardedProjection(match[0])) offenders.push(clause.trim());
    }
  }
  return offenders;
}

test("the lint flags a direct-write instruction and accepts a tool instruction", () => {
  assert.equal(projectionWriteInstructions("Then write `M001-CONTEXT.md` in the milestone directory.").length, 1);
  assert.equal(projectionWriteInstructions("Append one line to `.gsd/DECISIONS.md`.").length, 1);
  assert.equal(projectionWriteInstructions("Mark the task done and update .gsd/milestones/M001/slices/S01/S01-PLAN.md").length, 1);
  assert.deepEqual(projectionWriteInstructions("Do not write or edit `.gsd/PROJECT.md` directly."), []);
  assert.deepEqual(projectionWriteInstructions("Call `gsd_summary_save`; the tool writes `M001-CONTEXT.md`."), []);
  assert.deepEqual(projectionWriteInstructions("Write `docs/architecture.md` and update `README.md`."), []);
});

for (const name of promptNames) {
  test(`prompt ${name}: no managed projection is a write target`, () => {
    assert.deepEqual(projectionWriteInstructions(render(name)), []);
  });
}

/** The gsd tools a rendered prompt names. */
function gsdToolsIn(rendered: string): string[] {
  return [...new Set([...rendered.matchAll(/\bgsd_[a-z_]*[a-z]\b(?![_*])/g)].map((match) => match[0]))];
}

test("rendered prompts name only registered gsd tools", () => {
  const registered = registeredToolNames();
  const unknown: string[] = [];
  for (const name of promptNames) {
    for (const tool of gsdToolsIn(render(name))) {
      if (!registered.has(tool)) unknown.push(`${name}: ${tool}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test("the queue phase can call every gsd tool the queue prompt names", () => {
  const refused = gsdToolsIn(render("queue")).filter((tool) => shouldBlockQueueExecution(tool, "", true).block);
  assert.deepEqual(refused, []);
});

test("the discuss-milestone unit can call the dependency tool its prompts name", () => {
  const policy = resolveManifest("discuss-milestone")?.tools;
  assert.ok(policy, "discuss-milestone must have a tools policy");
  for (const prompt of ["discuss", "discuss-headless"]) {
    assert.ok(gsdToolsIn(render(prompt)).includes("gsd_milestone_set_dependencies"), `${prompt} names the tool`);
  }
  for (const toolName of ["gsd_milestone_set_dependencies", "mcp__gsd-workflow__gsd_milestone_set_dependencies"]) {
    const result = shouldBlockPlanningUnit(
      toolName, "", process.cwd(), "discuss-milestone", policy, undefined,
      { milestoneId: "M002", dependsOn: ["M001"] }, "M002",
    );
    assert.equal(result.block, false, result.reason);
  }
});
