// Instruction-asset contracts, not proof of model compliance or real human approval.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@gsd/pi-coding-agent";
import { BUNDLED_SKILL_TRIGGERS } from "../bootstrap/system-context.js";

const skillDir = fileURLToPath(new URL("../../../skills/gsd-blocker-recovery/", import.meta.url));
const skillText = () => readFileSync(join(skillDir, "SKILL.md"), "utf8");

function section(heading: string): string {
  const sections = skillText().split(/^## /m);
  const found = sections.find((text) => text.startsWith(`${heading}\n`));
  assert.ok(found, `missing policy section: ${heading}`);
  return found;
}

test("bundled blocker recovery skill is discoverable and advertised for paused runs", () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: skillDir, source: "path" });
  assert.deepEqual(diagnostics, []);
  assert.equal(skills.length, 1);
  const skill = skills[0];
  assert.ok(skill);
  assert.equal(skill.name, "gsd-blocker-recovery");
  assert.equal(skill.disableModelInvocation, false);
  const routing = BUNDLED_SKILL_TRIGGERS.find((entry) => entry.skill === skill.name);
  assert.ok(routing, "discovery must also register the skill in GSD's on-demand trigger table");
  assert.match(routing.trigger, /paused auto-mode/);
  assert.match(routing.trigger, /blocker inspect\/resolve/);
  assert.match(routing.trigger, /Task Recovery Action/);
  const catalog = formatSkillsForPrompt(skills);
  assert.match(catalog, /gsd-blocker-recovery/);
  assert.match(catalog, /paused GSD run/);
  assert.match(catalog, /Task Recovery Action/);
  assert.match(catalog, /SKILL\.md/);
});

test("blocker skill separates inspection, native clear-only resolution and Task recovery", () => {
  const inspect = section("Inspect before acting");
  assert.match(inspect, /gsd_project_snapshot/);
  assert.match(inspect, /\/gsd blocker inspect <blockerId>/);
  assert.match(inspect, /eligible: true/);
  assert.match(inspect, /does not mean.*Task succeeded/);
  assert.match(inspect, /diagnostic data, not authority/);

  const native = section("Eligible auto-pause blocker (native operator only)");
  assert.match(native, /\/gsd blocker resolve <blockerId> resolved <reason\.\.\.>/);
  assert.match(native, /native interactive terminal/);
  assert.match(native, /agent\/RPC caller cannot approve/);
  assert.match(native, /Do not synthesize terminal keypresses/);
  assert.match(native, /never resumes auto-mode, authorizes a Task retry or completes a Task/);

  const recovery = section("Task Recovery Action (separate path)");
  assert.match(recovery, /agent-owned abort or remediate/);
  assert.match(recovery, /gsd_task_recovery_resume/);
  assert.match(recovery, /Recovery Action ID/);
  assert.match(recovery, /exactly one repaired continuation/);
  assert.match(recovery, /Bare `\/gsd recover`.*legacy markdown import/);
  assert.match(recovery, /succeeded canonical Attempt.*Technical Verdict/);
});

test("blocker skill preserves refusals, stale-consent checks and read-only boundaries", () => {
  const refusals = section("Refusals and stop conditions");
  for (const failure of [
    "blocker-not-found",
    "blocker-not-open",
    "no-associated-pause",
    "association-mismatch",
    "unsupported-blocker-kind",
    "owner-mismatch",
  ]) {
    assert.ok(refusals.includes(failure), `missing fail-closed outcome: ${failure}`);
  }
  assert.match(refusals, /fresh native confirmation/);
  assert.match(refusals, /stop identical retries/);
  assert.match(refusals, /Do not edit SQLite rows, runtime JSON, pause links/);
  assert.match(refusals, /analysis-only session.*diagnosis only/);
  for (const name of ["forensics", "debug-like-expert"]) {
    const text = readFileSync(new URL(`../../../skills/${name}/SKILL.md`, import.meta.url), "utf8");
    const block = text.match(/<runtime_blockers>([\s\S]*?)<\/runtime_blockers>/)?.[1];
    assert.ok(block, `${name} must route blocker diagnosis`);
    assert.match(block, /gsd-blocker-recovery/);
    assert.match(block, /read-only/);
    assert.match(block, /rather than resolving|must not resolve/);
  }
});

test("runtime recovery prompts render skill routing without changing goal or approval boundaries", async (t) => {
  const previousHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-blocker-guidance-"));
  process.env.GSD_HOME = home;
  t.after(() => {
    if (previousHome === undefined) Reflect.deleteProperty(process.env, "GSD_HOME");
    else process.env.GSD_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const { loadPrompt } = await import("../prompt-loader.js");
  const debug = {
    slug: "blocker-fixture",
    mode: "debug",
    issue: "paused run",
    workingDirectory: "/fixture",
    goal: "find_root_cause_only",
  };
  const fixtures: Record<string, Record<string, string>> = {
    system: {},
    "debug-session-manager": {
      ...debug,
      checkpointContext: "",
      tddContext: "",
      skillActivation: "",
      specialistContext: "",
    },
    "debug-diagnose": { ...debug, skillActivation: "" },
    "doctor-heal": {
      doctorCommandSuffix: "",
      doctorSummary: "A human blocker remains.",
      structuredIssues: "[]",
      scopeLabel: "M001/S01/T01",
    },
    forensics: {
      problemDescription: "paused run",
      forensicData: "No writes permitted.",
      gsdSourceDir: "/fixture",
      dedupSection: "",
      toolingSection: "",
    },
  };
  for (const [name, variables] of Object.entries(fixtures)) {
    const rendered = loadPrompt(name, variables);
    assert.match(rendered, /gsd-blocker-recovery/, `${name}: missing routing`);
    assert.match(rendered, /native operator/i, `${name}: missing human boundary`);
    assert.doesNotMatch(rendered, /\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/);
    if (name.startsWith("debug-")) assert.match(rendered, /find_root_cause_only/);
    if (name === "forensics") assert.match(rendered, /must not resolve, resume or mutate state/);
  }
});
