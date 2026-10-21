// GSD Extension — Rule Registry Tests
//
// Tests the RuleRegistry class, UnifiedRule types, singleton accessors,
// and evaluation methods using mock rules.

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitJournalEvent } from "../journal.ts";
import {
  RuleRegistry,
  getRegistry,
  setRegistry,
  initRegistry,
  resetRegistry,
  convertDispatchRules,
  getOrCreateRegistry,
  resolveHookArtifactPath,
} from "../rule-registry.ts";
import type { UnifiedRule } from "../rule-types.ts";
import type { DispatchAction, DispatchContext } from "../auto-dispatch.ts";
import { DISPATCH_RULES, getDispatchRuleNames } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";

// ─── Mock Rule Factories ──────────────────────────────────────────────────

function mockDispatchRule(name: string, matchPhase: string): UnifiedRule {
  return {
    name,
    when: "dispatch",
    evaluation: "first-match",
    where: async (ctx: DispatchContext): Promise<DispatchAction | null> => {
      if (ctx.state.phase === matchPhase) {
        return {
          action: "dispatch",
          unitType: `test-${matchPhase}`,
          unitId: "test-id",
          prompt: `Prompt for ${matchPhase}`,
        };
      }
      return null;
    },
    then: () => {},
    description: `Mock rule for ${matchPhase}`,
  };
}

function makeContext(phase: string): DispatchContext {
  return {
    basePath: "/tmp/test",
    mid: "M001",
    midTitle: "Test Milestone",
    state: {
      phase: phase as any,
      activeMilestone: { id: "M001", title: "Test" },
      activeSlice: null,
      activeTask: null,
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [],
    },
    prefs: undefined,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("RuleRegistry", () => {
    beforeEach(() => {
    resetRegistry();
  });

  test("construct with dispatch rules, listRules returns them", () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("rule-a", "planning"),
      mockDispatchRule("rule-b", "executing"),
      mockDispatchRule("rule-c", "complete"),
    ];
    const registry = new RuleRegistry(rules);
    const listed = registry.listRules();

    // At minimum, dispatch rules are returned (hook rules depend on prefs)
    const dispatchRules = listed.filter(r => r.when === "dispatch");
    assert.deepStrictEqual(dispatchRules.length, 3, "listRules returns 3 dispatch rules");
    assert.deepStrictEqual(dispatchRules[0].name, "rule-a", "first rule name is rule-a");
    assert.deepStrictEqual(dispatchRules[1].name, "rule-b", "second rule name is rule-b");
    assert.deepStrictEqual(dispatchRules[2].name, "rule-c", "third rule name is rule-c");
  });

  test("listRules returns correct fields on each rule", () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("check-fields", "planning"),
    ];
    const registry = new RuleRegistry(rules);
    const listed = registry.listRules();
    const rule = listed.find(r => r.name === "check-fields")!;

    assert.ok(rule !== undefined, "rule found by name");
    assert.deepStrictEqual(rule.when, "dispatch", "when field is dispatch");
    assert.deepStrictEqual(rule.evaluation, "first-match", "evaluation is first-match");
    assert.ok(typeof rule.where === "function", "where is a function");
    assert.ok(typeof rule.then === "function", "then is a function");
    assert.deepStrictEqual(rule.description, "Mock rule for planning", "description is set");
  });

  test("evaluateDispatch returns first matching rule", async () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("rule-planning", "planning"),
      mockDispatchRule("rule-executing", "executing"),
      mockDispatchRule("rule-complete", "complete"),
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("executing");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "dispatch", "result is a dispatch action");
    if (result.action === "dispatch") {
      assert.deepStrictEqual(result.unitType, "test-executing", "matched the executing rule");
      assert.deepStrictEqual(result.prompt, "Prompt for executing", "prompt from matched rule");
    }
  });

  test("evaluateDispatch returns stop when no rule matches", async () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("only-planning", "planning"),
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("blocked");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "stop", "result is a stop action");
    if (result.action === "stop") {
      assert.ok(result.reason.includes("blocked"), "stop reason mentions phase");
    }
  });

  test("evaluateDispatch works with async where predicate", async () => {
    const asyncRule: UnifiedRule = {
      name: "async-rule",
      when: "dispatch",
      evaluation: "first-match",
      where: async (ctx: DispatchContext): Promise<DispatchAction | null> => {
        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 1));
        if (ctx.state.phase === "planning") {
          return {
            action: "dispatch",
            unitType: "async-test",
            unitId: "async-id",
            prompt: "Async prompt",
          };
        }
        return null;
      },
      then: () => {},
    };

    const registry = new RuleRegistry([asyncRule]);
    const ctx = makeContext("planning");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "dispatch", "async dispatch resolved");
    if (result.action === "dispatch") {
      assert.deepStrictEqual(result.unitType, "async-test", "async rule matched");
    }
  });

  test("resetState clears all mutable state", () => {
    const registry = new RuleRegistry([]);

    // Set up some state
    registry.activeHook = {
      hookName: "test-hook",
      triggerUnitType: "execute-task",
      triggerUnitId: "M001/S01/T01",
      cycle: 2,
      pendingRetry: false,
    };
    registry.hookQueue.push({
      config: { name: "q", after: [], prompt: "p" },
      triggerUnitType: "execute-task",
      triggerUnitId: "M001/S01/T02",
    });
    registry.cycleCounts.set("test/key", 3);
    registry.retryPending = true;
    registry.retryTrigger = { unitType: "execute-task", unitId: "M001/S01/T01", retryArtifact: "RETRY" };

    // Reset
    registry.resetState();

    assert.deepStrictEqual(registry.getActiveHook(), null, "activeHook cleared");
    assert.deepStrictEqual(registry.hookQueue.length, 0, "hookQueue cleared");
    assert.deepStrictEqual(registry.cycleCounts.size, 0, "cycleCounts cleared");
    assert.deepStrictEqual(registry.isRetryPending(), false, "retryPending cleared");
    assert.deepStrictEqual(registry.consumeRetryTrigger(), null, "retryTrigger cleared");
  });

  test("peekRetryTrigger observes a pending retry without consuming it", () => {
    const registry = new RuleRegistry([]);
    const expected = {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      retryArtifact: "NEEDS-REWORK.md",
    };
    registry.retryPending = true;
    registry.retryTrigger = expected;

    const peeked = registry.peekRetryTrigger();

    assert.deepStrictEqual(peeked, expected);
    assert.notStrictEqual(peeked, registry.retryTrigger, "peek returns a defensive copy");
    assert.equal(registry.isRetryPending(), true, "peek leaves the retry pending");
    assert.deepStrictEqual(registry.consumeRetryTrigger(), expected, "consume still acknowledges the trigger");
    assert.equal(registry.isRetryPending(), false);
  });

  test("pending hook retry survives registry persistence until acknowledged", () => {
    const basePath = mkdtempSync(join(tmpdir(), "gsd-hook-retry-state-"));
    const expected = {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      retryArtifact: "NEEDS-REWORK.md",
    };
    try {
      const beforeRestart = new RuleRegistry([]);
      beforeRestart.retryPending = true;
      beforeRestart.retryTrigger = expected;
      beforeRestart.persistState(basePath);

      const afterRestart = new RuleRegistry([]);
      afterRestart.restoreState(basePath);

      assert.equal(afterRestart.isRetryPending(), true);
      assert.deepEqual(afterRestart.peekRetryTrigger(), expected);
      assert.deepEqual(afterRestart.consumeRetryTrigger(), expected);
      assert.equal(afterRestart.isRetryPending(), false);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("singleton getRegistry throws when not initialized", () => {
    let threw = false;
    try {
      getRegistry();
    } catch (e: any) {
      threw = true;
      assert.ok(e.message.includes("not initialized"), "error mentions not initialized");
    }
    assert.ok(threw, "getRegistry threw");
  });

  test("setRegistry / getRegistry round-trips", () => {
    const registry = new RuleRegistry([mockDispatchRule("singleton-test", "planning")]);
    setRegistry(registry);

    const retrieved = getRegistry();
    assert.deepStrictEqual(retrieved, registry, "getRegistry returns the same instance");

    const listed = retrieved.listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(listed.length, 1, "singleton has 1 dispatch rule");
    assert.deepStrictEqual(listed[0].name, "singleton-test", "rule name matches");
  });

  test("initRegistry creates and sets singleton", () => {
    const rules = [mockDispatchRule("init-test", "executing")];
    const registry = initRegistry(rules);

    assert.deepStrictEqual(getRegistry(), registry, "initRegistry sets the singleton");
    const listed = getRegistry().listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(listed.length, 1, "singleton has the rule");
  });

  test("evaluateDispatch respects rule order (first match wins)", async () => {
    // Both rules match "planning" but rule-first should win
    const ruleFirst: UnifiedRule = {
      name: "rule-first",
      when: "dispatch",
      evaluation: "first-match",
      where: async (ctx: DispatchContext) => {
        if (ctx.state.phase === "planning") {
          return { action: "dispatch" as const, unitType: "first-wins", unitId: "id", prompt: "first" };
        }
        return null;
      },
      then: () => {},
    };
    const ruleSecond: UnifiedRule = {
      name: "rule-second",
      when: "dispatch",
      evaluation: "first-match",
      where: async (ctx: DispatchContext) => {
        if (ctx.state.phase === "planning") {
          return { action: "dispatch" as const, unitType: "second-loses", unitId: "id", prompt: "second" };
        }
        return null;
      },
      then: () => {},
    };

    const registry = new RuleRegistry([ruleFirst, ruleSecond]);
    const ctx = makeContext("planning");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "dispatch", "dispatch action returned");
    if (result.action === "dispatch") {
      assert.deepStrictEqual(result.unitType, "first-wins", "first rule won over second");
    }
  });

  // ── Dispatch rule conversion tests ─────────────────────────────────

  test("convertDispatchRules produces correct count of UnifiedRule objects", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    assert.deepStrictEqual(converted.length, DISPATCH_RULES.length, `convertDispatchRules produces ${DISPATCH_RULES.length} rules`);
  });

  test("each converted rule has correct when, evaluation, and original name", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    for (let i = 0; i < converted.length; i++) {
      const rule = converted[i];
      assert.deepStrictEqual(rule.when, "dispatch", `rule ${i} has when:"dispatch"`);
      assert.deepStrictEqual(rule.evaluation, "first-match", `rule ${i} has evaluation:"first-match"`);
      assert.deepStrictEqual(rule.name, DISPATCH_RULES[i].name, `rule ${i} preserves name "${DISPATCH_RULES[i].name}"`);
      assert.ok(typeof rule.where === "function", `rule ${i} has a where function`);
      assert.ok(typeof rule.then === "function", `rule ${i} has a then function`);
    }
  });

  test("listRules after construction with real dispatch rules returns correct count", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const listed = registry.listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(listed.length, DISPATCH_RULES.length, `listRules returns ${DISPATCH_RULES.length} dispatch rules`);
  });

  test("rule names from listRules match getDispatchRuleNames in exact order", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const listedNames = registry.listRules()
      .filter(r => r.when === "dispatch")
      .map(r => r.name);
    const originalNames = getDispatchRuleNames();

    assert.deepStrictEqual(listedNames.length, originalNames.length, "same number of names");
    for (let i = 0; i < originalNames.length; i++) {
      assert.deepStrictEqual(listedNames[i], originalNames[i], `name at index ${i} matches: "${originalNames[i]}"`);
    }
  });

  // ── getOrCreateRegistry (lazy init for facades) ────────────────────

  test("getOrCreateRegistry lazily creates a registry with empty dispatch rules", () => {
    // After resetRegistry(), getRegistry() would throw. getOrCreateRegistry() should not.
    const registry = getOrCreateRegistry();
    assert.ok(registry instanceof RuleRegistry, "returns a RuleRegistry instance");
    const dispatchRules = registry.listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(dispatchRules.length, 0, "lazily-created registry has 0 dispatch rules");
  });

  test("getOrCreateRegistry returns existing registry when initialized", () => {
    const rules = [mockDispatchRule("explicit-init", "planning")];
    const explicit = initRegistry(rules);
    const lazy = getOrCreateRegistry();
    assert.deepStrictEqual(lazy, explicit, "getOrCreateRegistry returns the same singleton as initRegistry");
    const dispatchRules = lazy.listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(dispatchRules.length, 1, "singleton has the explicitly initialized dispatch rule");
  });

  // ── Hook-derived rules in listRules ────────────────────────────────

  test("listRules returns only dispatch rules when no hooks are configured", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const allRules = registry.listRules();
    const postUnitRules = allRules.filter(r => r.when === "post-unit");
    const preDispatchRules = allRules.filter(r => r.when === "pre-dispatch");

    // No preferences file = no hooks
    assert.deepStrictEqual(postUnitRules.length, 0, "no post-unit rules when no hooks configured");
    assert.deepStrictEqual(preDispatchRules.length, 0, "no pre-dispatch rules when no hooks configured");
    assert.deepStrictEqual(allRules.length, DISPATCH_RULES.length, "total rules equals dispatch rules only");
  });

  test("listRules dispatch rules appear first, hooks after", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const allRules = registry.listRules();

    // Verify dispatch rules come first (indices 0..N-1)
    for (let i = 0; i < converted.length; i++) {
      assert.deepStrictEqual(allRules[i].when, "dispatch", `rule at index ${i} is a dispatch rule`);
      assert.deepStrictEqual(allRules[i].name, converted[i].name, `dispatch rule at index ${i} has correct name`);
    }
  });

  // ── Facade delegation (post-unit-hooks.ts imports work through registry) ──

  test("evaluatePostUnit returns null for hook-on-hook prevention", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("hook/code-review", "M001/S01/T01", "/tmp/test");
    assert.deepStrictEqual(result, null, "hook units don't trigger other hooks");
  });

  test("evaluatePostUnit returns null for triage-captures", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("triage-captures", "M001/S01/T01", "/tmp/test");
    assert.deepStrictEqual(result, null, "triage-captures skipped");
  });

  test("evaluatePostUnit returns null for quick-task", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("quick-task", "M001/S01/T01", "/tmp/test");
    assert.deepStrictEqual(result, null, "quick-task skipped");
  });

  test("evaluatePostUnit does not dispatch execute-task hooks before canonical completion", (t) => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-staged-task-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));

    t.after(() => {
      closeDatabase();
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    });

    mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "version: 1",
        "post_unit_hooks:",
        "  - name: review-after-task",
        "    after: [execute-task]",
        "    prompt: Review {taskId}",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    openDatabase(join(projectRoot, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active" });
    insertTask({
      id: "T01",
      milestoneId: "M001",
      sliceId: "S01",
      title: "Staged Task",
      status: "pending",
    });

    const registry = new RuleRegistry([]);
    assert.equal(
      registry.evaluatePostUnit("execute-task", "M001/S01/T01", projectRoot),
      null,
      "verify-staged Tasks must fail closed without dispatching hooks",
    );
  });

  test("evaluatePreDispatch bypasses hook units", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePreDispatch("hook/review", "M001/S01/T01", "prompt", "/tmp/test");
    assert.deepStrictEqual(result.action, "proceed", "hook units always proceed");
    assert.deepStrictEqual(result.prompt, "prompt", "prompt unchanged");
    assert.deepStrictEqual(result.firedHooks.length, 0, "no hooks fired");
  });

  test("evaluatePreDispatch proceeds with empty hooks", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePreDispatch("execute-task", "M001/S01/T01", "original prompt", "/tmp/test");
    assert.deepStrictEqual(result.action, "proceed", "proceeds when no hooks");
    assert.deepStrictEqual(result.prompt, "original prompt", "prompt unchanged");
  });

  test("hook evaluation loads preferences from explicit basePath when cwd is an isolated worktree", () => {
    const originalCwd = process.cwd();
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-base-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "gsd-hook-worktree-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));

    try {
      mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
      writeFileSync(
        join(projectRoot, ".gsd", "PREFERENCES.md"),
        [
          "---",
          "version: 1",
          "pre_dispatch_hooks:",
          "  - name: policy-prepend",
          "    before: [complete-slice]",
          "    action: modify",
          "    prepend: POLICY TEXT HERE",
          "post_unit_hooks:",
          "  - name: review-after-task",
          "    after: [plan-slice]",
          "    prompt: Review {taskId}",
          "---",
        ].join("\n"),
        "utf-8",
      );

      process.env.GSD_HOME = tempGsdHome;
      process.chdir(worktreeRoot);

      const registry = new RuleRegistry([]);
      const preResult = registry.evaluatePreDispatch(
        "complete-slice",
        "M001/S01",
        "original prompt",
        projectRoot,
      );

      assert.deepStrictEqual(preResult.action, "proceed");
      assert.ok(preResult.prompt?.startsWith("POLICY TEXT HERE"), "pre-dispatch hook prepends policy text");
      assert.deepStrictEqual(preResult.firedHooks, ["policy-prepend"]);

      const postResult = registry.evaluatePostUnit("plan-slice", "M001/S01/T01", projectRoot);
      assert.notEqual(postResult, null, "post-unit hook dispatches from basePath preferences");
      assert.deepStrictEqual(postResult!.hookName, "review-after-task");
      assert.equal(postResult!.prompt.includes("Review T01"), true);
    } finally {
      process.chdir(originalCwd);
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("failed hook completion with an artifact does not dequeue the next hook", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-failed-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    const unitId = "M001/S01/T01";

    try {
      mkdirSync(join(projectRoot, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
      writeFileSync(
        join(projectRoot, ".gsd", "PREFERENCES.md"),
        [
          "---",
          "version: 1",
          "post_unit_hooks:",
          "  - name: review-arbiter",
          "    after: [plan-slice]",
          "    prompt: Review {taskId}",
          "    artifact: REVIEW.md",
          "    max_cycles: 1",
          "  - name: follow-up-review",
          "    after: [plan-slice]",
          "    prompt: Follow-up review {taskId}",
          "---",
        ].join("\n"),
        "utf-8",
      );
      process.env.GSD_HOME = tempGsdHome;

      const registry = new RuleRegistry([]);
      const firstHook = registry.evaluatePostUnit("plan-slice", unitId, projectRoot);
      assert.equal(firstHook?.hookName, "review-arbiter");

      writeFileSync(
        resolveHookArtifactPath(projectRoot, unitId, "REVIEW.md"),
        "partial review output",
        "utf-8",
      );
      emitJournalEvent(projectRoot, {
        ts: "2026-06-03T12:00:00.000Z",
        flowId: "flow-hook-failed",
        seq: 3,
        eventType: "unit-end",
        data: {
          unitType: "hook/review-arbiter",
          unitId,
          status: "cancelled",
          artifactVerified: false,
          errorContext: {
            message: "Provider error: Stream ended without finish_reason",
            category: "provider",
          },
        },
      });

      const nextHook = registry.evaluatePostUnit("hook/review-arbiter", unitId, projectRoot);
      assert.equal(nextHook, null, "failed hook must not allow follow-up hook dispatch");
      const failure = registry.consumeHookFailure();
      assert.equal(failure?.hookName, "review-arbiter");
      assert.match(failure?.reason ?? "", /status cancelled/);

      const resumedRegistry = new RuleRegistry([]);
      resumedRegistry.restoreState(projectRoot);
      const resumedHook = resumedRegistry.evaluatePostUnit("plan-slice", unitId, projectRoot);
      assert.equal(resumedHook, null, "resumed hook evaluation must not skip failed hook artifact");
      assert.equal(resumedRegistry.consumeHookFailure()?.hookName, "review-arbiter");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  // ── matchedRule provenance (S02 journal support) ───────────────────

  test("evaluateDispatch result includes matchedRule on dispatch match", async () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("my-planning-rule", "planning"),
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("planning");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "dispatch", "result is a dispatch action");
    assert.deepStrictEqual(result.matchedRule, "my-planning-rule", "matchedRule is the rule name");
  });

  test("evaluateDispatch result includes matchedRule '<no-match>' on fallback stop", async () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("only-planning", "planning"),
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("some-unknown-phase");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "stop", "result is a stop action");
    assert.deepStrictEqual(result.matchedRule, "<no-match>", "matchedRule is '<no-match>' on fallback");
  });
});

describe("resolveHookArtifactPath", () => {
  test("resolves a phase-level artifact from the .gsd/phases layout", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-phase-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const phaseDir = join(realpathSync(projectRoot), ".gsd", "phases", "50-some-phase");
      mkdirSync(phaseDir, { recursive: true });
      const artifactPath = join(phaseDir, "BROWSER-RUNTIME-EVIDENCE.md");
      writeFileSync(artifactPath, "---\nverdict: advisory\n---\n", "utf-8");

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02/T01", "BROWSER-RUNTIME-EVIDENCE.md");
      assert.equal(resolved, artifactPath, "resolves the canonical phase-level artifact");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("resolves canonical flat-phase scoped artifact names", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-flat-scope-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const phaseDir = join(realpathSync(projectRoot), ".gsd", "phases", "50-some-phase");
      mkdirSync(phaseDir, { recursive: true });
      const milestoneArtifactPath = join(phaseDir, "50-PLAN-REVIEW.md");
      const sliceArtifactPath = join(phaseDir, "50-02-PLAN-REVIEW.md");
      const taskArtifactPath = join(phaseDir, "S02-T01-REVIEW.md");
      writeFileSync(milestoneArtifactPath, "---\nverdict: pass\n---\n", "utf-8");
      writeFileSync(sliceArtifactPath, "---\nverdict: needs-attention\n---\n", "utf-8");
      writeFileSync(taskArtifactPath, "---\nverdict: advisory\n---\n", "utf-8");

      assert.equal(
        resolveHookArtifactPath(projectRoot, "M050", "PLAN-REVIEW.md"),
        milestoneArtifactPath,
        "resolves the canonical milestone-prefixed flat artifact",
      );
      assert.equal(
        resolveHookArtifactPath(projectRoot, "M050/S02", "PLAN-REVIEW.md"),
        sliceArtifactPath,
        "resolves the canonical slice-prefixed flat artifact",
      );
      assert.equal(
        resolveHookArtifactPath(projectRoot, "M050/S02/T01", "REVIEW.md"),
        taskArtifactPath,
        "resolves the canonical slice/task-prefixed flat artifact",
      );
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("flat-phase missing slice artifact fallback points at the canonical slice path", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-flat-slice-miss-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const phaseDir = join(realpathSync(projectRoot), ".gsd", "phases", "50-some-phase");
      mkdirSync(phaseDir, { recursive: true });

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02", "PLAN-REVIEW.md");
      assert.equal(
        resolved,
        join(phaseDir, "50-02-PLAN-REVIEW.md"),
        "diagnostic fallback uses the collision-free slice-prefixed path",
      );
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("falls back to the legacy milestones/slices/tasks layout", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-legacy-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const tasksDir = join(projectRoot, ".gsd", "milestones", "M050", "slices", "S02", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      const artifactPath = join(tasksDir, "T01-REVIEW.md");
      writeFileSync(artifactPath, "---\nverdict: pass\n---\n", "utf-8");

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02/T01", "REVIEW.md");
      assert.equal(resolved, artifactPath, "resolves the task-prefixed legacy artifact");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("legacy: nested task artifact wins over a milestone-root file of the same name", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-legacy-root-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const milestoneDir = join(projectRoot, ".gsd", "milestones", "M050");
      const tasksDir = join(milestoneDir, "slices", "S02", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      // The correct task-scoped artifact lives in the nested slices/tasks tree.
      const nestedPath = join(tasksDir, "T01-REVIEW.md");
      writeFileSync(nestedPath, "---\nverdict: pass\n---\n", "utf-8");
      // A same-named decoy at the legacy milestone root must NOT win — before the
      // fix, resolveMilestonePath returned the milestone root and it was probed
      // ahead of the nested task path (#1264 Bugbot follow-up).
      writeFileSync(join(milestoneDir, "REVIEW.md"), "---\nverdict: failed\n---\n", "utf-8");

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02/T01", "REVIEW.md");
      assert.equal(resolved, nestedPath, "task-scoped legacy path wins over the milestone-root file");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("legacy: missing-artifact fallback points at the nested task path, not the milestone root", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-legacy-miss-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const milestoneDir = join(projectRoot, ".gsd", "milestones", "M050");
      mkdirSync(milestoneDir, { recursive: true });
      // Content-bearing legacy milestone dir (a non-META file) so resolveMilestonePath
      // returns it, but the requested gate artifact does not exist anywhere.
      writeFileSync(join(milestoneDir, "M050-ROADMAP.md"), "# roadmap\n", "utf-8");

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02/T01", "REVIEW.md");
      const expected = join(milestoneDir, "slices", "S02", "tasks", "T01-REVIEW.md");
      assert.equal(resolved, expected, "diagnostic fallback uses the nested task path for a legacy task-scoped unit");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });
});
