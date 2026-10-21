import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { ModelPolicyDispatchBlockedError, resolvePreferredModelConfig, resolveModelId, selectAndApplyModel, floorThinkingLevelForUnit } from "../auto-model-selection.js";
import { blockModelUntil, clearTemporaryModelBlocksForTest } from "../blocked-models.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("resolvePreferredModelConfig synthesizes heavy routing ceiling when models section is absent", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        // burn-max disables profile-based model injection so the synthesis path
        // (dynamic_routing.tier_models.heavy → primary) is exercised as intended.
        // Without this, the D046 balanced default injects models.planning and the
        // function returns source:"explicit" before reaching synthesis.
        "token_profile: burn-max",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: claude-haiku-4-5",
        "    standard: claude-sonnet-4-6",
        "    heavy: claude-opus-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const config = resolvePreferredModelConfig("plan-slice", {
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });

    assert.deepEqual(config, {
      primary: "claude-opus-4-6",
      fallbacks: [],
      source: "synthesized",
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("resolvePreferredModelConfig treats token-profile model defaults as synthesized routing", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-profile-project-");
  const tempGsdHome = makeTempDir("gsd-routing-profile-home-");

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "token_profile: quality",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: claude-haiku-4-5",
        "    standard: claude-sonnet-4-6",
        "    heavy: claude-opus-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const config = resolvePreferredModelConfig(
      "plan-slice",
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      },
      true,
      tempProject,
      [
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-sonnet-4-6",
        "anthropic/claude-opus-4-6",
      ],
      "anthropic/claude-sonnet-4-6",
    );

    assert.deepEqual(config, {
      primary: "claude-opus-4-6",
      fallbacks: [],
      source: "synthesized",
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("resolvePreferredModelConfig falls back to auto start model when heavy tier is absent", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        // burn-max: no profile model injection → synthesis path runs
        "token_profile: burn-max",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: claude-haiku-4-5",
        "    standard: claude-sonnet-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const config = resolvePreferredModelConfig("execute-task", {
      provider: "openai",
      id: "gpt-5.4",
    });

    assert.deepEqual(config, {
      primary: "openai/gpt-5.4",
      fallbacks: [],
      source: "synthesized",
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("resolvePreferredModelConfig keeps explicit phase models as the ceiling", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "models:",
        "  planning: claude-sonnet-4-6",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    heavy: claude-opus-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const config = resolvePreferredModelConfig("plan-slice", {
      provider: "anthropic",
      id: "claude-opus-4-6",
    });

    assert.deepEqual(config, {
      primary: "claude-sonnet-4-6",
      fallbacks: [],
      source: "explicit",
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

// #1115 regression: a token_profile with dynamic_routing enabled but NO
// tier_models pins must still resolve the profile's per-phase model as a
// synthesized routing ceiling. Before the fix, resolvePreferredModelConfig
// bailed to undefined here (explicit detection skips profile defaults, and the
// synthesis path required tier_models), so auto dispatch fell back to the
// start model for every unit and silently discarded the profile.
test("resolvePreferredModelConfig resolves profile per-phase models as synthesized when tier_models are absent", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-profile-notier-");
  const tempGsdHome = makeTempDir("gsd-routing-profile-notier-home-");

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "token_profile: budget",
        "dynamic_routing:",
        "  enabled: true",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const availableModelIds = [
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
    ];
    const start = { provider: "anthropic", id: "claude-sonnet-4-6" };
    // preferredModelId is intentionally left undefined so profile tier
    // resolution is exercised rather than pinning every tier to the session
    // model (a heavy session model can satisfy every tier).
    const resolve = (unitType: string) =>
      resolvePreferredModelConfig(unitType, start, true, tempProject, availableModelIds);

    // budget profile: research=light, planning=standard, execution=standard,
    // execution_simple=light, completion=light (PROFILE_TIER_MAP).
    assert.deepEqual(resolve("research-milestone"), {
      primary: "claude-haiku-4-5",
      fallbacks: [],
      source: "synthesized",
    });
    assert.deepEqual(resolve("plan-milestone"), {
      primary: "claude-sonnet-4-6",
      fallbacks: [],
      source: "synthesized",
    });
    assert.deepEqual(resolve("execute-task"), {
      primary: "claude-sonnet-4-6",
      fallbacks: [],
      source: "synthesized",
    });
    assert.deepEqual(resolve("execute-task-simple"), {
      primary: "claude-haiku-4-5",
      fallbacks: [],
      source: "synthesized",
    });
    assert.deepEqual(resolve("complete-slice"), {
      primary: "claude-haiku-4-5",
      fallbacks: [],
      source: "synthesized",
    });
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

// #1115 guard: the explicit flat-rate opt-out must suppress synthesized routing
// even on the profile-derived (no tier_models) path — the opt-out moved ahead
// of both synthesis branches, so a flat-rate start model with
// allow_flat_rate_providers:false yields no config (start model is used as-is).
test("resolvePreferredModelConfig honors flat-rate opt-out on the profile path (no tier_models)", () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-flatrate-notier-");
  const tempGsdHome = makeTempDir("gsd-routing-flatrate-notier-home-");

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "token_profile: budget",
        "dynamic_routing:",
        "  enabled: true",
        "  allow_flat_rate_providers: false",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const config = resolvePreferredModelConfig(
      "execute-task",
      // claude-code is a built-in flat-rate provider.
      { provider: "claude-code", id: "claude-opus-4-6" },
      true,
      tempProject,
      ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
    );

    assert.equal(config, undefined);
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("selectAndApplyModel honors explicit phase models without downgrading (#3617)", async () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-project-");
  const tempGsdHome = makeTempDir("gsd-routing-home-");
  const setModelCalls: string[] = [];
  let beforeModelSelectCalled = false;

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "models:",
        "  planning: claude-opus-4-6",
        "dynamic_routing:",
        "  enabled: true",
        "  tier_models:",
        "    light: gpt-4o-mini",
        "    standard: claude-sonnet-4-6",
        "    heavy: claude-opus-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const availableModels = [
      { id: "claude-opus-4-6", provider: "anthropic", api: "anthropic-messages" },
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
      { id: "gpt-4o-mini", provider: "openai", api: "responses" },
    ];

    const result = await selectAndApplyModel(
      {
        modelRegistry: { getAvailable: () => availableModels },
        sessionManager: { getSessionId: () => "test-session" },
        ui: { notify: () => {} },
        model: { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" },
      } as any,
      {
        setModel: async (model: { provider: string; id: string }) => {
          setModelCalls.push(`${model.provider}/${model.id}`);
          return true;
        },
        emitBeforeModelSelect: async () => {
          beforeModelSelectCalled = true;
          return undefined;
        },
        getActiveTools: () => [],
        emitAdjustToolSet: async () => undefined,
        setActiveTools: () => {},
      } as any,
      "plan-slice",
      "slice-1",
      tempProject,
      undefined,
      false,
      { provider: "anthropic", id: "claude-opus-4-6" },
      undefined,
      true,
    );

    assert.equal(beforeModelSelectCalled, false, "explicit phase models should skip dynamic routing hooks");
    assert.deepEqual(setModelCalls, ["anthropic/claude-opus-4-6"]);
    assert.equal(result.routing, null, "explicit phase models should not record a routing downgrade");
    assert.equal(result.appliedModel?.provider, "anthropic");
    assert.equal(result.appliedModel?.id, "claude-opus-4-6");
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("selectAndApplyModel skips a rate-limited primary until its reset time", async () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-rate-limit-fallback-project-");
  const tempGsdHome = makeTempDir("gsd-rate-limit-fallback-home-");
  const setModelCalls: string[] = [];

  try {
    clearTemporaryModelBlocksForTest();
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "models:",
        "  execution:",
        "    model: gpt-5.5",
        "    provider: openai-codex",
        "    fallbacks:",
        "      - anthropic/claude-sonnet-4-6",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const availableModels = [
      { id: "gpt-5.5", provider: "openai-codex", api: "responses" },
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    ];
    const ctx = {
      modelRegistry: { getAvailable: () => availableModels },
      sessionManager: { getSessionId: () => "test-session" },
      ui: { notify: () => {} },
      model: { provider: "openai-codex", id: "gpt-5.5", api: "responses" },
    } as any;
    const pi = {
      setModel: async (model: { provider: string; id: string }) => {
        setModelCalls.push(`${model.provider}/${model.id}`);
        return true;
      },
      emitBeforeModelSelect: async () => undefined,
      getActiveTools: () => [],
      emitAdjustToolSet: async () => undefined,
      setActiveTools: () => {},
    } as any;

    blockModelUntil(tempProject, "openai-codex", "gpt-5.5", Date.now() + 60_000, "session limit");
    await selectAndApplyModel(ctx, pi, "execute-task", "M001/S01/T01", tempProject, undefined, false, { provider: "openai-codex", id: "gpt-5.5" }, undefined, true);

    blockModelUntil(tempProject, "openai-codex", "gpt-5.5", Date.now() - 1, "expired");
    await selectAndApplyModel(ctx, pi, "execute-task", "M001/S01/T02", tempProject, undefined, false, { provider: "openai-codex", id: "gpt-5.5" }, undefined, true);

    assert.deepEqual(setModelCalls, [
      "anthropic/claude-sonnet-4-6",
      "openai-codex/gpt-5.5",
    ]);
  } finally {
    clearTemporaryModelBlocksForTest();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("selectAndApplyModel lets explicit unit models bypass stale cross-provider lock (#116)", async () => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-explicit-cross-provider-project-");
  const tempGsdHome = makeTempDir("gsd-explicit-cross-provider-home-");
  const setModelCalls: string[] = [];

  try {
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    writeFileSync(
      join(tempProject, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "models:",
        "  research:",
        "    model: claude-opus-4-7",
        "    provider: claude-code",
        "    fallbacks:",
        "      - deepseek/deepseek-v4-pro-20260423",
        "dynamic_routing:",
        "  enabled: true",
        "  cross_provider: false",
        "uok:",
        "  model_policy:",
        "    enabled: true",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    process.chdir(tempProject);

    const availableModels = [
      { id: "gpt-5.5", provider: "openai-codex", api: "responses" },
      { id: "claude-opus-4-7", provider: "claude-code", api: "anthropic-messages" },
      { id: "deepseek-v4-pro-20260423", provider: "deepseek", api: "openai-chat" },
    ];

    let thrown: unknown;
    try {
      await selectAndApplyModel(
        {
          modelRegistry: { getAvailable: () => availableModels },
          sessionManager: { getSessionId: () => "test-session" },
          ui: { notify: () => {} },
          model: { provider: "openai-codex", id: "gpt-5.5", api: "responses" },
        } as any,
        {
          setModel: async (model: { provider: string; id: string }) => {
            setModelCalls.push(`${model.provider}/${model.id}`);
            return true;
          },
          emitBeforeModelSelect: async () => undefined,
          getActiveTools: () => [],
          emitAdjustToolSet: async () => undefined,
          setActiveTools: () => {},
        } as any,
        "research-slice",
        "M014-veveb9/parallel-research",
        tempProject,
        undefined,
        false,
        { provider: "openai-codex", id: "gpt-5.5" },
        undefined,
        true,
      );
    } catch (e) {
      thrown = e;
    }

    assert.ok(!(thrown instanceof ModelPolicyDispatchBlockedError), "explicit research config must not be blocked by stale provider");
    if (thrown) throw thrown;
    assert.deepEqual(setModelCalls, ["claude-code/claude-opus-4-7"]);
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

test("selectAndApplyModel escalates dynamic routing tier when retry metadata is provided", async (t) => {
  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = makeTempDir("gsd-routing-retry-project-");
  const tempGsdHome = makeTempDir("gsd-routing-retry-home-");
  const setModelCalls: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  t.after(() => {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  });

  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    [
      "---",
      // burn-max: no profile model injection → synthesis ceiling = heavy tier
      // → source:"synthesized" → dynamic routing escalation is active on retry
      "token_profile: burn-max",
      "dynamic_routing:",
      "  enabled: true",
      "  hooks: false",
      "  budget_pressure: false",
      "  tier_models:",
      "    light: claude-haiku-4-5",
      "    standard: claude-sonnet-4-6",
      "    heavy: claude-opus-4-6",
      "---",
    ].join("\n"),
    "utf-8",
  );
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(tempProject);

  const availableModels = [
    { id: "claude-haiku-4-5", provider: "anthropic", api: "anthropic-messages" },
    { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    { id: "claude-opus-4-6", provider: "anthropic", api: "anthropic-messages" },
  ];

  const result = await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => availableModels },
      sessionManager: { getSessionId: () => "test-session" },
      ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
      model: { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" },
    } as any,
    {
      setModel: async (model: { provider: string; id: string }) => {
        setModelCalls.push(`${model.provider}/${model.id}`);
        return true;
      },
      emitBeforeModelSelect: async () => undefined,
      getActiveTools: () => [],
      emitAdjustToolSet: async () => undefined,
      setActiveTools: () => {},
    } as any,
    "execute-task",
    "M001/S01/T01",
    tempProject,
    undefined,
    false,
    { provider: "anthropic", id: "claude-opus-4-6" },
    { isRetry: true, previousTier: "light" },
    true,
  );

  assert.deepEqual(setModelCalls, ["anthropic/claude-sonnet-4-6"]);
  assert.deepEqual(result.routing, { tier: "standard", modelDowngraded: true });
  assert.equal(result.appliedModel?.id, "claude-sonnet-4-6");
  assert.ok(
    notifications.some(n => n.message.includes("Tier escalation: light") && n.message.includes("standard")),
    "retry metadata should produce a visible tier escalation notification",
  );
});

// ─── resolveModelId tests ─────────────────────────────────────────────────

test("resolveModelId: bare ID resolves to claude-code when session is claude-code (#3772)", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "claude-code" },
  ];

  // When currentProvider is "claude-code" (set by startup migration for subscription
  // users), bare IDs must resolve to claude-code to avoid the third-party block (#3772).
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "claude-code", "bare ID must resolve to claude-code when session provider is claude-code");
});

test("resolveModelId: bare ID still prefers current provider when it is a first-class API provider", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "bedrock" },
  ];

  const result = resolveModelId("claude-sonnet-4-6", availableModels, "bedrock");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "bedrock", "bare ID should prefer current provider when it is a real API provider");
});

test("resolveModelId: explicit provider/model format still resolves to claude-code when specified", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", provider: "claude-code" },
  ];

  const result = resolveModelId("claude-code/claude-sonnet-4-6", availableModels, "anthropic");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "claude-code", "explicit provider prefix must be respected");
});

test("resolveModelId: bare ID with only one provider works normally", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "anthropic" },
  ];

  const result = resolveModelId("claude-sonnet-4-6", availableModels, "anthropic");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "anthropic");
});

test("resolveModelId: bare ID with claude-code as only provider still resolves", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" },
  ];

  // If claude-code is the ONLY provider for this model, it should still resolve
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve even when only available via claude-code");
  assert.equal(result.provider, "claude-code");
});

// ─── selectAndApplyModel verbose-gating tests ──────────────────────────

test("model change notify in selectAndApplyModel is gated behind verbose flag", async (t) => {
  const originalCwd = process.cwd();
  const tempProject = makeTempDir("gsd-routing-verbose-project-");
  const notifications: Array<{ message: string; level: string }> = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(tempProject, { recursive: true, force: true });
  });

  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    ["---", "models:", "  planning: claude-sonnet-4-6", "---"].join("\n"),
    "utf-8",
  );
  process.chdir(tempProject);

  await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [{ id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }] },
      sessionManager: { getSessionId: () => "test-session" },
      ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
      model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" },
    } as any,
    {
      setModel: async () => true,
      emitBeforeModelSelect: async () => undefined,
      getActiveTools: () => [],
      emitAdjustToolSet: async () => undefined,
      setActiveTools: () => {},
    } as any,
    "plan-slice",
    "M001/S01",
    tempProject,
    undefined,
    false,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    undefined,
    true,
  );

  assert.deepEqual(notifications, []);
});

test("selectAndApplyModel re-applies captured thinking level after setModel success", async (t) => {
  const originalCwd = process.cwd();
  const tempProject = makeTempDir("gsd-routing-thinking-project-");
  const thinkingLevels: unknown[] = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(tempProject, { recursive: true, force: true });
  });

  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    ["---", "models:", "  planning: claude-sonnet-4-6", "---"].join("\n"),
    "utf-8",
  );
  process.chdir(tempProject);

  await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [{ id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }] },
      sessionManager: { getSessionId: () => "test-session" },
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
    tempProject,
    undefined,
    false,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    undefined,
    true,
    undefined,
    { effort: "high" } as any,
  );

  assert.deepEqual(thinkingLevels, [{ effort: "high" }]);
});

// ─── floorThinkingLevelForUnit (#read-bash-thrash) ─────────────────────
test("floorThinkingLevelForUnit raises minimal/low to the floor for execute-task", () => {
  assert.equal(floorThinkingLevelForUnit("execute-task", "off" as any), "medium");
  assert.equal(floorThinkingLevelForUnit("execute-task", "minimal" as any), "medium");
  assert.equal(floorThinkingLevelForUnit("execute-task", "low" as any), "medium");
});

test("floorThinkingLevelForUnit never lowers a level already at/above the floor", () => {
  assert.equal(floorThinkingLevelForUnit("execute-task", "medium" as any), "medium");
  assert.equal(floorThinkingLevelForUnit("execute-task", "high" as any), "high");
  assert.equal(floorThinkingLevelForUnit("execute-task", "xhigh" as any), "xhigh");
});

test("floorThinkingLevelForUnit leaves non-execute-task units untouched", () => {
  for (const unit of ["plan-slice", "plan-milestone", "research-milestone", "complete-slice", "validate-milestone"]) {
    assert.equal(floorThinkingLevelForUnit(unit, "minimal" as any), "minimal");
  }
});

test("floorThinkingLevelForUnit passes through null/undefined and unrecognized shapes", () => {
  assert.equal(floorThinkingLevelForUnit("execute-task", null), null);
  assert.equal(floorThinkingLevelForUnit("execute-task", undefined), undefined);
  // A richer host snapshot object must not be coerced into a bare string.
  const snapshot = { effort: "minimal" } as any;
  assert.deepEqual(floorThinkingLevelForUnit("execute-task", snapshot), snapshot);
});

test("selectAndApplyModel raises minimal thinking to the floor for execute-task", async (t) => {
  const originalCwd = process.cwd();
  const tempProject = makeTempDir("gsd-routing-thinking-floor-");
  const thinkingLevels: unknown[] = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(tempProject, { recursive: true, force: true });
  });

  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    ["---", "models:", "  execute-task: claude-sonnet-4-6", "---"].join("\n"),
    "utf-8",
  );
  process.chdir(tempProject);

  await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [{ id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }] },
      sessionManager: { getSessionId: () => "test-session" },
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
    "execute-task",
    "M001/S01/T01",
    tempProject,
    undefined,
    false,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    undefined,
    true,
    undefined,
    "minimal" as any,
  );

  assert.deepEqual(thinkingLevels, ["medium"]);
});

test("selectAndApplyModel capability-clamps an unsupported thinking level (ADR-026)", async (t) => {
  const originalCwd = process.cwd();
  const tempProject = makeTempDir("gsd-routing-thinking-clamp-");
  const thinkingLevels: unknown[] = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(tempProject, { recursive: true, force: true });
  });

  // Reasoning-capable model whose map omits xhigh → xhigh must clamp to high.
  const model = {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
  };
  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    ["---", "models:", "  planning: claude-sonnet-4-6", "---"].join("\n"),
    "utf-8",
  );
  process.chdir(tempProject);

  await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [model] },
      sessionManager: { getSessionId: () => "test-session" },
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
    tempProject,
    undefined,
    false,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    undefined,
    true,
    undefined,
    "xhigh" as any,
  );

  assert.deepEqual(thinkingLevels, ["high"]);
});

test("selectAndApplyModel applies an explicit per-phase thinking level (ADR-026)", async (t) => {
  const originalCwd = process.cwd();
  const tempProject = makeTempDir("gsd-routing-thinking-explicit-");
  const thinkingLevels: unknown[] = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(tempProject, { recursive: true, force: true });
  });

  const model = {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
  };
  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    ["---", "models:", "  planning:", "    model: claude-sonnet-4-6", "    thinking: xhigh", "---"].join("\n"),
    "utf-8",
  );
  process.chdir(tempProject);

  await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [model] },
      sessionManager: { getSessionId: () => "test-session" },
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
    tempProject,
    undefined,
    false,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    undefined,
    true,
    undefined,
    // Session level is "low"; the explicit planning thinking (xhigh) must win.
    "low" as any,
  );

  assert.deepEqual(thinkingLevels, ["xhigh"]);
});

test("selectAndApplyModel applies explicit thinking with no model pin (interactive, ADR-026)", async (t) => {
  const originalCwd = process.cwd();
  const tempProject = makeTempDir("gsd-routing-thinking-nomodel-");
  const thinkingLevels: unknown[] = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(tempProject, { recursive: true, force: true });
  });

  const model = {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
  };
  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  // A `thinking:` block with NO models config — the interactive guided-flow
  // scenario the bug report flagged (no per-phase model, no start model).
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    ["---", "thinking:", "  planning: high", "---"].join("\n"),
    "utf-8",
  );
  process.chdir(tempProject);

  await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [model] },
      sessionManager: { getSessionId: () => "test-session" },
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
    tempProject,
    undefined,
    false,
    null,            // no autoModeStartModel
    undefined,
    false,           // isAutoMode = false (interactive)
    undefined,
    undefined,       // no captured session thinking level
  );

  // No model branch runs, but the explicit block thinking must still apply.
  assert.deepEqual(thinkingLevels, ["high"]);
});

test("selectAndApplyModel clamps explicit no-model thinking via ctx.model when registry lookup fails (ADR-026)", async (t) => {
  const originalCwd = process.cwd();
  const tempProject = makeTempDir("gsd-routing-thinking-ctxmodel-");
  const thinkingLevels: unknown[] = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(tempProject, { recursive: true, force: true });
  });

  // ctx.model carries reasoning capability (map omits xhigh) but the registry
  // returns nothing, so resolveModelId fails and ctx.model is the clamp source.
  const ctxModel = {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
  };
  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  writeFileSync(
    join(tempProject, ".gsd", "PREFERENCES.md"),
    ["---", "thinking:", "  planning: xhigh", "---"].join("\n"),
    "utf-8",
  );
  process.chdir(tempProject);

  await selectAndApplyModel(
    {
      // Empty registry results force the clamp source to fall back to ctx.model.
      modelRegistry: {
        getAvailable: () => [],
        getAll: () => [],
        isProviderRequestReady: () => true,
      },
      sessionManager: { getSessionId: () => "test-session" },
      ui: { notify: () => {} },
      model: ctxModel,
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
    tempProject,
    undefined,
    false,
    null,
    undefined,
    false,
    undefined,
    undefined,
  );

  // xhigh is unsupported by ctx.model → clamped to high, never sent verbatim.
  assert.deepEqual(thinkingLevels, ["high"]);
});

test("resolveModelId: anthropic wins over claude-code when session provider is not claude-code", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" },
    { id: "claude-sonnet-4-6", provider: "anthropic" },
  ];

  // When the session is NOT on claude-code, bare IDs should resolve to
  // the canonical anthropic provider (original #2905 behavior preserved).
  const result = resolveModelId("claude-sonnet-4-6", availableModels, undefined);
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "anthropic", "anthropic must win when session is not claude-code");
});

test("resolveModelId: claude-code wins when session is claude-code regardless of list order", () => {
  const availableModels = [
    { id: "claude-sonnet-4-6", provider: "claude-code" },
    { id: "claude-sonnet-4-6", provider: "anthropic" },
  ];

  // When session provider is claude-code (subscription user migration), it must
  // win regardless of candidate ordering to avoid the third-party block (#3772).
  const result = resolveModelId("claude-sonnet-4-6", availableModels, "claude-code");
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "claude-code", "claude-code must win when it is the session provider");
});

test("resolveModelId: openai-codex wins over openai for bare GPT IDs when both are available", () => {
  const availableModels = [
    { id: "gpt-5.5", provider: "openai" },
    { id: "gpt-5.5", provider: "openai-codex" },
  ];

  const result = resolveModelId("gpt-5.5", availableModels, undefined);
  assert.ok(result, "should resolve a model");
  assert.equal(result.provider, "openai-codex", "ChatGPT OAuth must win over platform API for bare IDs");
});

test("resolveModelId: github-copilot wins over openai when both offer the same GPT model", () => {
  const availableModels = [
    { id: "gpt-5.5", provider: "openai" },
    { id: "gpt-5.5", provider: "github-copilot" },
  ];

  const result = resolveModelId("gpt-5.5", availableModels, undefined);
  assert.ok(result);
  assert.equal(result.provider, "github-copilot");
});

test("resolveModelId: github-copilot alias resolves explicit provider/model when registry uses copilot", () => {
  const availableModels = [
    { id: "claude-sonnet-5", provider: "copilot" },
  ];

  const result = resolveModelId("github-copilot/claude-sonnet-5", availableModels, undefined);
  assert.ok(result, "should resolve via provider alias");
  assert.equal(result.provider, "copilot");
  assert.equal(result.id, "claude-sonnet-5");
});

test("resolveModelId: copilot alias wins over openai in bare-ID precedence", () => {
  const availableModels = [
    { id: "gpt-5.5", provider: "openai" },
    { id: "gpt-5.5", provider: "copilot" },
  ];

  const result = resolveModelId("gpt-5.5", availableModels, undefined);
  assert.ok(result);
  assert.equal(result.provider, "copilot");
});
