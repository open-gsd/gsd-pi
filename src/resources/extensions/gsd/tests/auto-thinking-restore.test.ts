import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { selectAndApplyModel, applyThinkingLevelForModel } from "../auto-model-selection.ts";
import { stopAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { closeDatabase } from "../gsd-db.ts";

test("selectAndApplyModel restores captured thinking level after model selection", async (t) => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-thinking-restore-"));
  const thinkingLevels: unknown[] = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    ["---", "models:", "  planning: anthropic/claude-sonnet-4-6", "---"].join("\n"),
    "utf-8",
  );
  process.chdir(base);

  const result = await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [{ id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }] },
      sessionManager: { getSessionId: () => "thinking-test" },
      ui: { notify: () => {} },
      model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" },
    } as any,
    {
      setModel: async () => true,
      setThinkingLevel: (level: unknown) => { thinkingLevels.push(level); },
      emitBeforeModelSelect: async () => undefined,
      getActiveTools: () => [],
      emitAdjustToolSet: async () => undefined,
      setActiveTools: () => {},
    } as any,
    "plan-slice",
    "M001/S01",
    base,
    undefined,
    false,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    undefined,
    true,
    undefined,
    { effort: "medium" } as any,
  );

  assert.equal(result.appliedModel?.provider, "anthropic");
  assert.deepEqual(thinkingLevels, [{ effort: "medium" }]);
});

test("applyThinkingLevelForModel applies per-unit levels in memory only (#2828)", () => {
  const calls: unknown[][] = [];
  const pi = {
    setThinkingLevel: (level: unknown, options?: unknown) => {
      calls.push([level, options]);
    },
  };
  const ctx = { ui: { notify: () => {} } } as any;
  const model = { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages", reasoning: true };

  applyThinkingLevelForModel(pi as any, "high", model as any, ctx);
  // Non-string snapshots bypass capability clamping and apply verbatim.
  applyThinkingLevelForModel(pi as any, { effort: "medium" } as any, model as any, ctx);

  assert.deepEqual(calls, [
    ["high", { persist: false }],
    [{ effort: "medium" }, { persist: false }],
  ]);
});

test("stopAuto restores the original model and thinking level in memory only (#2828)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-stop-model-restore-"));
  const previousCwd = process.cwd();
  const setModelCalls: unknown[][] = [];
  const setThinkingCalls: unknown[][] = [];
  const originalModel = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-completions" };

  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  });

  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.originalModelProvider = originalModel.provider;
  autoSession.originalModelId = originalModel.id;
  autoSession.originalThinkingLevel = "medium";

  await stopAuto(
    {
      hasUI: true,
      ui: {
        setStatus: () => {},
        setWidget: () => {},
        setHeader: () => {},
        notify: () => {},
      },
      modelRegistry: {
        find: (provider: string, id: string) =>
          provider === originalModel.provider && id === originalModel.id ? originalModel : null,
      },
    } as any,
    {
      events: { emit: () => {} },
      setModel: async (model: unknown, options?: unknown) => {
        setModelCalls.push([model, options]);
        return true;
      },
      setThinkingLevel: (level: unknown, options?: unknown) => {
        setThinkingCalls.push([level, options]);
      },
    } as any,
    "stop",
  );

  // The run's start model/level are restored for the session only — the
  // stored global defaults must stay untouched (#2076, #2828).
  assert.deepEqual(setModelCalls, [[originalModel, { persist: false }]]);
  assert.deepEqual(setThinkingCalls, [["medium", { persist: false }]]);
});
