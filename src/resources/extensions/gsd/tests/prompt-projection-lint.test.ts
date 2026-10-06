// Project/App: gsd-pi
// File Purpose: Every gsd tool a prompt names is registered and callable in the phase that uses the prompt,
// and no rendered prompt tells the agent to write a managed projection path.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrompt } from "../prompt-loader.ts";
import { WORKFLOW_TOOL_SURFACE_NAMES } from "../workflow-tool-surface.ts";
import { registerDbTools } from "../bootstrap/db-tools.ts";
import { registerExecTools } from "../bootstrap/exec-tools.ts";
import { registerJournalTools } from "../bootstrap/journal-tools.ts";
import { registerMemoryTools } from "../bootstrap/memory-tools.ts";
import { registerQueryTools } from "../bootstrap/query-tools.ts";
import { shouldBlockPlanningUnit, shouldBlockQueueExecution } from "../bootstrap/write-gate.ts";
import { managedProjectionSaveToolByName } from "../write-intercept.ts";
import { resolveManifest } from "../unit-context-manifest.ts";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const promptNames = readdirSync(promptsDir).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3));

/** Render a prompt through the loader; the loader reports the variables it needs. */
function render(name: string): string {
  try {
    return loadPrompt(name);
  } catch (err) {
    const declared = [...(err as Error).message.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)].map((match) => match[1]);
    assert.ok(declared.length > 0, `loadPrompt("${name}") failed: ${(err as Error).message}`);
    return loadPrompt(name, Object.fromEntries(declared.map((variable) => [variable, `<${variable}>`])));
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

// ─── Managed projection paths are never a prompt's write target ────────────
//
// The write guard refuses an agent write to STATE.md, gsd.db or a managed
// projection, naming the save tool that renders the file. The prompts must
// agree with the guard: a rendered prompt may mention those paths (they are
// the render output the agent reads) but must not direct a write at them.
// A line passes when the write is negated ("do not edit"), describes a
// render ("the tool regenerates it"), or names the gsd tool that owns the
// save; anything else fails the lint.

const PATH_TOKEN_RE = /[\w./\\-]+\.(?:md|json)/gi;
const WRITE_VERB_RE =
  /\b(writes?|wrote|written|creates?|created|appends?|appending|append|edits?|editing|edit|updates?|updating|update|saves?|saving|echo|overwrite|touch)\b/i;
const NOT_A_WRITE_TARGET_RE =
  /\b(do not|does not|don't|never|must not|no longer|without writing|instead of writing|rather than|rendered|renders|render|was written|were written|the written)\b/i;
const GSD_TOOL_RE = /\bgsd_[a-z_]*[a-z]\b/i;

function isManagedPathToken(token: string): boolean {
  if (/STATE\.md$|gsd\.db(-wal|-shm)?$/i.test(token)) return true;
  return managedProjectionSaveToolByName(token) !== null;
}

/** The rendered prompt lines that direct a write at a managed projection path outside a gsd tool. */
function managedWriteTargetLines(rendered: string): string[] {
  const offenders: string[] = [];
  for (const line of rendered.split("\n")) {
    const managed = [...new Set([...line.matchAll(PATH_TOKEN_RE)]
      .map((match) => match[0])
      .filter(isManagedPathToken))];
    if (managed.length === 0) continue;
    if (!WRITE_VERB_RE.test(line)) continue;
    if (NOT_A_WRITE_TARGET_RE.test(line)) continue;
    if (GSD_TOOL_RE.test(line)) continue;
    offenders.push(`${managed.join(", ")} — ${line.trim()}`);
  }
  return offenders;
}

test("no rendered prompt tells the agent to write a managed projection path", () => {
  const offenders: string[] = [];
  for (const name of promptNames) {
    for (const line of managedWriteTargetLines(render(name))) offenders.push(`${name}: ${line}`);
  }
  assert.deepEqual(offenders, []);
});

test("the lint itself catches a prompt line that appends to a managed projection", () => {
  assert.deepEqual(managedWriteTargetLines("Append the capture to `.gsd/CAPTURES.md` and continue."), [
    ".gsd/CAPTURES.md — Append the capture to `.gsd/CAPTURES.md` and continue.",
  ]);
  assert.deepEqual(managedWriteTargetLines("Write `.gsd/milestones/M001/M001-PLAN.md` with the plan."), [
    ".gsd/milestones/M001/M001-PLAN.md — Write `.gsd/milestones/M001/M001-PLAN.md` with the plan.",
  ]);
});
