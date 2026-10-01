// Subagent Model system-prompt block (#2245 / #2394).
//
// The bootstrap must not inject a hard tool-level "always pass this model …
// Never omit" instruction: it shadows agents that declare a frontmatter
// `model` (launch.ts applies `modelOverride ?? agent.model`) and gives manual
// subagent dispatches no per-task complexity signal. The block is instead
// frontmatter-aware (agent's own model governs) or advisory-by-complexity.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import {
  buildBeforeAgentStartResult,
  buildSubagentModelBlock,
  hasFrontmatterModelAgent,
  _flushDeferredContextMaintenanceForTest,
} from "../bootstrap/system-context.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import { closeDatabase, isDbAvailable } from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";

const HARD_ALWAYS_PASS_PIN = 'always pass `model: "';

interface Harness {
  base: string;
  ctx: ExtensionContext;
}

function makeHarness(t: TestContext, opts: { agentFrontmatter?: string }): Harness {
  const base = mkdtempSync(join(tmpdir(), "gsd-subagent-model-"));
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const originalAgentDir = process.env.GSD_CODING_AGENT_DIR;
  const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  mkdirSync(join(base, ".gsd-home", "agent"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: base, stdio: "ignore" });
  writeFileSync(
    join(gsdDir, "PREFERENCES.md"),
    ["---", "token_profile: burn-max", "models:", "  subagent: test-provider/test-subagent-model", "---"].join("\n"),
    "utf-8",
  );
  if (opts.agentFrontmatter !== undefined) {
    mkdirSync(join(gsdDir, "agents"), { recursive: true });
    writeFileSync(
      join(gsdDir, "agents", "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Structured code review",
        opts.agentFrontmatter,
        "---",
        "",
        "Review the change.",
      ].join("\n"),
      "utf-8",
    );
  }

  process.chdir(base);
  process.env.GSD_HOME = join(base, ".gsd-home");
  // Isolate user-scope agent discovery from the developer machine.
  process.env.GSD_CODING_AGENT_DIR = join(base, ".gsd-home", "agent");
  process.env.PI_CODING_AGENT_DIR = join(base, ".gsd-home", "agent");

  t.after(async () => {
    await _flushDeferredContextMaintenanceForTest(base);
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    clearGSDPreferencesCache();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    if (originalAgentDir === undefined) delete process.env.GSD_CODING_AGENT_DIR;
    else process.env.GSD_CODING_AGENT_DIR = originalAgentDir;
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    rmSync(base, { recursive: true, force: true });
  });

  const ctx = {
    projectRoot: base,
    sessionManager: { getSessionId: () => "session-subagent-model" },
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;

  return { base, ctx };
}

test("#2245 frontmatter-model agent: hard always-pass block is replaced by agent-model-governs guidance", async (t) => {
  const harness = makeHarness(t, { agentFrontmatter: "model: opencode-go/kimi-k3" });
  const result = await buildBeforeAgentStartResult(
    { prompt: "do some work", systemPrompt: "base system prompt" },
    harness.ctx,
  );
  assert.ok(result, "bootstrap should produce a result for a project with a .gsd");
  assert.ok(result.systemPrompt.includes("## Subagent Model"), "block should still be present");
  assert.ok(
    result.systemPrompt.includes("frontmatter"),
    "guidance must state that the agent's own frontmatter model governs",
  );
  assert.ok(
    !result.systemPrompt.includes(HARD_ALWAYS_PASS_PIN),
    "hard tool-level always-pass instruction must not be injected when an agent declares a frontmatter model",
  );
  assert.ok(
    !result.systemPrompt.includes("Never omit this"),
    "the 'Never omit' mandate must be gone (#2245)",
  );
});

test("#2394 no frontmatter models: block is advisory-by-complexity, not a single mandated model", async (t) => {
  const harness = makeHarness(t, {});
  const result = await buildBeforeAgentStartResult(
    { prompt: "do some work", systemPrompt: "base system prompt" },
    harness.ctx,
  );
  assert.ok(result, "bootstrap should produce a result for a project with a .gsd");
  assert.ok(result.systemPrompt.includes("## Subagent Model"), "block should still be present");
  assert.ok(
    result.systemPrompt.includes("per task complexity"),
    "guidance must instruct complexity-based model choice (#2394)",
  );
  assert.ok(
    result.systemPrompt.includes("test-provider/test-subagent-model"),
    "the resolved models.subagent value stays visible as the suggested default",
  );
  assert.ok(
    result.systemPrompt.includes("lightweight/recon"),
    "lightweight/recon dispatches must not be defaulted to the phase ceiling (#2394)",
  );
  assert.ok(
    !result.systemPrompt.includes(HARD_ALWAYS_PASS_PIN),
    "the single mandated tool-level model must be gone (#2394)",
  );
  assert.ok(
    !result.systemPrompt.includes("Never omit this"),
    "the 'Never omit' mandate must be gone (#2394)",
  );
});

test("#2245 no models.subagent configured: no block is injected (behavior preserved)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-subagent-model-none-"));
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  mkdirSync(join(base, ".gsd-home"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: base, stdio: "ignore" });

  process.chdir(base);
  process.env.GSD_HOME = join(base, ".gsd-home");

  t.after(async () => {
    await _flushDeferredContextMaintenanceForTest(base);
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    clearGSDPreferencesCache();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(base, { recursive: true, force: true });
  });

  const ctx = {
    projectRoot: base,
    sessionManager: { getSessionId: () => "session-subagent-model-none" },
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
  const result = await buildBeforeAgentStartResult(
    { prompt: "do some work", systemPrompt: "base system prompt" },
    ctx,
  );
  assert.ok(result, "bootstrap should produce a result for a project with a .gsd");
  assert.ok(
    !result.systemPrompt.includes("## Subagent Model"),
    "block must stay absent when models.subagent is unconfigured",
  );
});

test("#2245 malformed agent frontmatter must not break context injection (fail open to advisory)", async (t) => {
  const harness = makeHarness(t, { agentFrontmatter: "model: [unclosed" });
  const result = await buildBeforeAgentStartResult(
    { prompt: "do some work", systemPrompt: "base system prompt" },
    harness.ctx,
  );
  assert.ok(result, "bootstrap must still produce a result with a malformed agent file present");
  assert.ok(result.systemPrompt.includes("## Subagent Model"), "advisory block should still be injected");
  assert.ok(
    !result.systemPrompt.includes(HARD_ALWAYS_PASS_PIN),
    "malformed agent discovery must fail open to the advisory block, not the hard mandate",
  );
});

test("#2245 modeled user agent is detected even when a model-less project agent shares its name", (t) => {
  const harness = makeHarness(t, {});
  mkdirSync(join(harness.base, ".gsd", "agents"), { recursive: true });
  writeFileSync(
    join(harness.base, ".gsd", "agents", "reviewer.md"),
    ["---", "name: reviewer", "description: Project reviewer", "---"].join("\n"),
    "utf-8",
  );
  assert.equal(hasFrontmatterModelAgent(harness.base), false, "model-less project agent alone must not trip detection");
  mkdirSync(join(harness.base, ".gsd-home", "agent", "agents"), { recursive: true });
  writeFileSync(
    join(harness.base, ".gsd-home", "agent", "agents", "reviewer.md"),
    ["---", "name: reviewer", "description: User reviewer", "model: opencode-go/kimi-k3", "---"].join("\n"),
    "utf-8",
  );
  assert.equal(
    hasFrontmatterModelAgent(harness.base),
    true,
    "a modeled user agent must be detected despite the same-name model-less project agent (agentScope:user is reachable)",
  );
});

test("#2245 malformed user agent scope must not hide a modeled project agent", (t) => {
  const harness = makeHarness(t, {});
  mkdirSync(join(harness.base, ".gsd", "agents"), { recursive: true });
  writeFileSync(
    join(harness.base, ".gsd", "agents", "reviewer.md"),
    ["---", "name: reviewer", "description: Structured code review", "model: opencode-go/kimi-k3", "---"].join("\n"),
    "utf-8",
  );
  // The user scope is discovered first; its parse failure must be caught and
  // not prevent the modeled project agent from being detected.
  mkdirSync(join(harness.base, ".gsd-home", "agent", "agents"), { recursive: true });
  writeFileSync(
    join(harness.base, ".gsd-home", "agent", "agents", "scout.md"),
    ["---", "name: scout", "description: User scout", "model: [unclosed", "---"].join("\n"),
    "utf-8",
  );
  assert.equal(
    hasFrontmatterModelAgent(harness.base),
    true,
    "per-scope discovery failure must not discard the other scope's modeled agent",
  );
});

test("buildSubagentModelBlock wording branches", () => {
  const frontmatter = buildSubagentModelBlock("p/m", true);
  assert.ok(frontmatter.includes("do not pass a `model` override"));
  assert.ok(frontmatter.includes("unless the caller explicitly requests"));
  assert.ok(frontmatter.includes("per item"), "parallel/chain per-item override caveat must be stated");
  assert.ok(frontmatter.includes("lightweight/recon"), "model-less agents keep the lightweight/recon guidance");
  assert.ok(!frontmatter.includes("Never omit this"));

  const advisory = buildSubagentModelBlock("p/m", false);
  assert.ok(advisory.includes("per task complexity"));
  assert.ok(advisory.includes("`p/m`"));
  assert.ok(advisory.includes("Use the caller's requested model when one is specified"));
  assert.ok(advisory.includes("always pass an explicit `model`"));
  assert.ok(!advisory.includes("Never omit this"));
});

test("hasFrontmatterModelAgent detects project agents with and without declared model", (t) => {
  const harness = makeHarness(t, {});
  assert.equal(hasFrontmatterModelAgent(harness.base), false);
  mkdirSync(join(harness.base, ".gsd", "agents"), { recursive: true });
  writeFileSync(
    join(harness.base, ".gsd", "agents", "reviewer.md"),
    ["---", "name: reviewer", "description: Structured code review", "model: opencode-go/kimi-k3", "---"].join("\n"),
    "utf-8",
  );
  assert.equal(hasFrontmatterModelAgent(harness.base), true);
});
