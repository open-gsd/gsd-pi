// Project/App: gsd-pi
// File Purpose: Verifies model routing decisions and legacy provider-default telemetry.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import type { Api, Model } from "@gsd/pi-ai";

import type { ClassificationResult } from "../complexity-classifier.js";
import { getLegacyTelemetry, resetLegacyTelemetry } from "../legacy-telemetry.js";
import {
  canonicalizeModelId,
  computeTaskRequirements,
  defaultRoutingConfig,
  escalateTier,
  getEligibleModels,
  getModelProfileConfidence,
  MODEL_CAPABILITY_PROFILES,
  MODEL_CAPABILITY_TIER,
  resolveModelForComplexity,
  resolveModelForTier,
  scoreEligibleModels,
  scoreModel,
} from "../model-router.js";
import type { DynamicRoutingConfig, ModelCapabilities, RoutingDecision } from "../model-router.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClassification(tier: "light" | "standard" | "heavy", reason = "test"): ClassificationResult {
  return { tier, reason, downgraded: false };
}

const AVAILABLE_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gpt-4o-mini",
];

test("routes MAI Code 1.1 Flash as a light-tier model", () => {
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    { ...defaultRoutingConfig(), enabled: true },
    ["claude-opus-4-6", "mai-code-1.1-flash"],
  );

  assert.equal(result.modelId, "mai-code-1.1-flash");
  assert.equal(result.wasDowngraded, true);
});

// ─── Passthrough when disabled ───────────────────────────────────────────────

test("returns configured model when routing is disabled", () => {
  const config = { ...defaultRoutingConfig(), enabled: false };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});

test("returns configured model when no phase config", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    undefined,
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "");
  assert.equal(result.wasDowngraded, false);
});

// ─── Downgrade-only semantics ────────────────────────────────────────────────

test("does not downgrade when tier matches configured model tier", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});

test("does not upgrade beyond configured model", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  // Configured model is sonnet (standard), classification says heavy
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-sonnet-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "claude-sonnet-4-6");
  assert.equal(result.wasDowngraded, false);
});

test("downgrades from opus to haiku for light tier", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  // Should pick haiku or gpt-4o-mini (cheapest light tier)
  assert.ok(
    result.modelId === "claude-haiku-4-5" || result.modelId === "gpt-4o-mini",
    `Expected light-tier model, got ${result.modelId}`,
  );
  assert.equal(result.wasDowngraded, true);
});

test("downgrades from opus to sonnet for standard tier", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "claude-sonnet-4-6");
  assert.equal(result.wasDowngraded, true);
});

test("separator variants preserve GitHub Copilot downgrade and ceiling semantics", async (t) => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const variants = [
    ["dotted", "claude-opus-4.6", "claude-sonnet-4.6", "claude-haiku-4.5"],
    ["underscored", "claude_opus_4_6", "claude_sonnet_4_6", "claude_haiku_4_5"],
    ["hyphenated", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  ];

  for (const [label, opus, sonnet, haiku] of variants) {
    await t.test(label, () => {
      const qualify = (id: string) => `github-copilot/${id}`;
      const copilotModels = [qualify(opus), qualify(sonnet), qualify(haiku)];

      const standard = resolveModelForComplexity(
        makeClassification("standard"),
        { primary: qualify(opus), fallbacks: [] },
        config,
        copilotModels,
      );
      assert.equal(standard.modelId, qualify(sonnet));
      assert.equal(standard.wasDowngraded, true);

      const light = resolveModelForComplexity(
        makeClassification("light"),
        { primary: qualify(opus), fallbacks: [] },
        config,
        copilotModels,
      );
      assert.equal(light.modelId, qualify(haiku));
      assert.equal(light.wasDowngraded, true);

      const heavy = resolveModelForComplexity(
        makeClassification("heavy"),
        { primary: qualify(opus), fallbacks: [] },
        config,
        copilotModels,
      );
      assert.equal(heavy.modelId, qualify(opus));
      assert.equal(heavy.wasDowngraded, false);
    });
  }
});

test("canonicalizeModelId normalizes provider prefixes, whitespace, casing, and separators", () => {
  const variants = [
    "github-copilot/claude-sonnet-4.6",
    "github-copilot/claude_sonnet_4_6",
    "  GITHUB-COPILOT/CLAUDE-SONNET-4-6  ",
    "openai/gpt_4.1-mini",
    "google/gemini-flash-2.0",
  ];
  assert.deepEqual(variants.map(canonicalizeModelId), [
    "claude-sonnet-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6",
    "gpt-4-1-mini",
    "gemini-2-0-flash",
  ]);
});

test("routing registries store canonical keys only", () => {
  for (const modelId of [
    ...Object.keys(MODEL_CAPABILITY_TIER),
    ...Object.keys(MODEL_CAPABILITY_PROFILES),
  ]) {
    assert.equal(modelId, canonicalizeModelId(modelId));
  }
});

// ─── Explicit tier_models ────────────────────────────────────────────────────

test("uses explicit tier_models when configured", () => {
  const config: DynamicRoutingConfig = {
    ...defaultRoutingConfig(),
    enabled: true,
    tier_models: { light: "gpt-4o-mini", standard: "claude-sonnet-4-6" },
  };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "gpt-4o-mini");
  assert.equal(result.wasDowngraded, true);
});

test("preserves explicit provider-qualified tier_models when duplicate bare IDs exist", () => {
  const config: DynamicRoutingConfig = {
    ...defaultRoutingConfig(),
    enabled: true,
    capability_routing: false,
    tier_models: {
      light: "custom-openai/gpt-5.3-codex-spark",
      standard: "custom-openai/gpt-5.4",
    },
  };
  const providerModels = [
    "openai-codex/gpt-5.4",
    "custom-openai/gpt-5.4",
    "openai-codex/gpt-5.3-codex-spark",
    "custom-openai/gpt-5.3-codex-spark",
    "custom-anthropic/claude-opus-4-7",
  ];

  const standard = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "custom-anthropic/claude-opus-4-7", fallbacks: [] },
    config,
    providerModels,
  );
  assert.equal(standard.modelId, "custom-openai/gpt-5.4");
  assert.equal(standard.wasDowngraded, true);

  const light = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "custom-anthropic/claude-opus-4-7", fallbacks: [] },
    config,
    providerModels,
  );
  assert.equal(light.modelId, "custom-openai/gpt-5.3-codex-spark");
  assert.equal(light.wasDowngraded, true);
});

// ─── Fallback chain construction ─────────────────────────────────────────────

test("fallback chain includes configured primary as last resort", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: ["claude-sonnet-4-6"] },
    config,
    AVAILABLE_MODELS,
  );
  assert.ok(result.wasDowngraded);
  // Fallbacks should include the configured fallbacks and primary
  assert.ok(result.fallbacks.includes("claude-opus-4-6"), "primary should be in fallbacks");
  assert.ok(result.fallbacks.includes("claude-sonnet-4-6"), "configured fallback should be in fallbacks");
});

// ─── Escalation ──────────────────────────────────────────────────────────────

test("escalateTier moves light → standard", () => {
  assert.equal(escalateTier("light"), "standard");
});

test("escalateTier moves standard → heavy", () => {
  assert.equal(escalateTier("standard"), "heavy");
});

test("escalateTier returns null for heavy (max)", () => {
  assert.equal(escalateTier("heavy"), null);
});

// ─── No suitable model available ─────────────────────────────────────────────

test("falls back to configured model when no light-tier model available", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  // Only heavy-tier models available
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["claude-opus-4-6"],
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});

// ─── #2192: Unknown models honor explicit config ─────────────────────────────

test("#2192: unknown model warns and is not downgraded", (t) => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "some-future-unknown-model-v9", fallbacks: [] },
    config,
    ["some-future-unknown-model-v9", ...AVAILABLE_MODELS],
  );
  assert.equal(result.modelId, "some-future-unknown-model-v9", "unknown model should be used as-is");
  assert.equal(result.wasDowngraded, false, "should not be downgraded");
  assert.ok(result.reason.includes("not in the known tier map"), "reason should explain why");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /does not recognize.*honoring the configured model/i);
});

test("#2192: unknown model with provider prefix is not downgraded", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "custom-provider/my-model-v3", fallbacks: [] },
    config,
    ["custom-provider/my-model-v3", ...AVAILABLE_MODELS],
  );
  assert.equal(result.modelId, "custom-provider/my-model-v3");
  assert.equal(result.wasDowngraded, false);
});

test("#2192: known model is still downgraded normally", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  // claude-opus-4-6 is known as "heavy" — a light request should downgrade
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.wasDowngraded, true, "known heavy model should still be downgraded for light tasks");
  assert.notEqual(result.modelId, "claude-opus-4-6");
});

// ─── Cross-provider fallback ──────────────────────────────────────────────────

test("uses cross-provider equivalent when configured primary is unavailable", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  // Profile default says claude-opus-4-6 for planning, but user is on GPT only
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["gpt-4o", "gpt-4o-mini", "o1"],
  );
  // o1 is the heavy-tier GPT model — should be selected as cross-provider equivalent
  assert.equal(result.modelId, "o1");
  assert.equal(result.wasDowngraded, false);
  assert.match(result.reason, /cross-provider/);
});

test("cross-provider: selects standard-tier equivalent when primary unavailable", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  // Planning configured with Opus, but only GPT standard models available
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["gpt-4o", "gpt-4o-mini"],
  );
  // gpt-4o is standard tier, not heavy — no heavy-tier model available
  // Should fall back to gpt-4o (best available)
  assert.ok(result.modelId === "gpt-4o" || result.modelId === "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});

test("cross-provider: configured primary available by bare ID wins over equivalent", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  // Provider-prefixed ID — bare match should find it
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["anthropic/claude-opus-4-6", "o1"],
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});

test("resolveModelForComplexity: preferred GLM session model wins over cheaper standard-tier GLM models", () => {
  const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: false };
  const result = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["zai/glm-4.5-air", "zai/glm-5.1", "zai/glm-5.2"],
    "execute-task",
    undefined,
    undefined,
    "zai/glm-5.2",
  );
  assert.equal(result.modelId, "zai/glm-5.2");
  assert.equal(result.selectionMethod, "tier-only");
});

test("resolveModelForComplexity: wasDowngraded is false when preferred session model matches configuredPrimary with different ID format", () => {
  // configuredPrimary is bare ("claude-opus-4-6"), preferred comes back as provider-prefixed
  // ("anthropic/claude-opus-4-6") from availableModelIds. They refer to the same model —
  // wasDowngraded must NOT be true, which would otherwise trigger a spurious UI notification.
  const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: false };
  const result = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["anthropic/claude-opus-4-6"],
    "execute-task",
    undefined,
    undefined,
    "anthropic/claude-opus-4-6",
  );
  assert.equal(result.modelId, "anthropic/claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});

// ─── resolveModelForTier (provider-agnostic tier resolution) ────────────────

test("resolveModelForTier: returns canonical Anthropic model when no available models", () => {
  try {
    resetLegacyTelemetry();
    assert.equal(resolveModelForTier("heavy", []), "claude-opus-4-6");
    assert.equal(resolveModelForTier("standard", []), "claude-sonnet-4-6");
    assert.equal(resolveModelForTier("light", []), "claude-haiku-4-5");
    assert.equal(getLegacyTelemetry()["legacy.providerDefaultUsed"], 3);
  } finally {
    resetLegacyTelemetry();
  }
});

test("resolveModelForTier: returns canonical model when it is available", () => {
  try {
    resetLegacyTelemetry();
    assert.equal(
      resolveModelForTier("heavy", ["claude-opus-4-6", "claude-sonnet-4-6"]),
      "claude-opus-4-6",
    );
    assert.equal(getLegacyTelemetry()["legacy.providerDefaultUsed"], 0);
  } finally {
    resetLegacyTelemetry();
  }
});

test("resolveModelForTier: does not prefer canonical over cheaper same-tier model", () => {
  const result = resolveModelForTier("light", ["claude-haiku-4-5", "gpt-4o-mini"]);
  assert.equal(result, "gpt-4o-mini");
});

test("resolveModelForTier: honors configured tier_models pins", () => {
  const config: DynamicRoutingConfig = {
    ...defaultRoutingConfig(),
    tier_models: { light: "claude-haiku-4-5" },
  };
  const result = resolveModelForTier("light", ["claude-haiku-4-5", "gpt-4o-mini"], config);
  assert.equal(result, "claude-haiku-4-5");
});

test("resolveModelForTier: picks cross-provider equivalent when Anthropic unavailable", () => {
  // Only OpenAI models available
  const result = resolveModelForTier("heavy", ["gpt-4o", "gpt-4o-mini", "o1"]);
  // o1 is the heavy-tier model in the OpenAI lineup
  assert.equal(result, "o1");
});

test("resolveModelForTier: picks standard-tier cross-provider model", () => {
  const result = resolveModelForTier("standard", ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(result, "gpt-4o");
});

test("resolveModelForTier: picks light-tier cross-provider model", () => {
  const result = resolveModelForTier("light", ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(result, "gpt-4o-mini");
});

test("resolveModelForTier: preserves selected standard-tier model over cheaper same-tier provider models", () => {
  const result = resolveModelForTier(
    "standard",
    ["zai/glm-4.5-air", "zai/glm-5.1", "zai/glm-5.2"],
    defaultRoutingConfig(),
    true,
    "zai/glm-5.2",
  );
  assert.equal(result, "zai/glm-5.2");
});

test("resolveModelForTier: light tier with no light provider model stays on selected provider model", () => {
  try {
    resetLegacyTelemetry();
    const result = resolveModelForTier(
      "light",
      ["zai/glm-4.5-air", "zai/glm-5.1", "zai/glm-5.2"],
      defaultRoutingConfig(),
      true,
      "zai/glm-5.2",
    );
    assert.equal(result, "zai/glm-5.2");
    assert.equal(getLegacyTelemetry()["legacy.providerDefaultUsed"], 0);
  } finally {
    resetLegacyTelemetry();
  }
});

test("resolveModelForTier: cross_provider:false ignores non-Anthropic preferred model and returns Claude", () => {
  // When dynamic_routing.cross_provider is false, the sameProvider (Claude-only) filter must
  // win over a non-Anthropic session model — the preferred model must not bypass the restriction.
  const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), cross_provider: false };
  const result = resolveModelForTier(
    "standard",
    ["zai/glm-5.2", "claude-sonnet-4-6"],
    config,
    false, // crossProvider=false
    "zai/glm-5.2",
  );
  assert.equal(result, "claude-sonnet-4-6");
});

test("resolveModelForTier: cross_provider:false honors preferred model when it is a Claude model", () => {
  // When the session model itself is a Claude model, it should still win within the
  // same-provider restriction.
  const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), cross_provider: false };
  const result = resolveModelForTier(
    "standard",
    ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"],
    config,
    false,
    "anthropic/claude-sonnet-4-6",
  );
  assert.equal(result, "claude-sonnet-4-6");
});

test("resolveModelForTier: non-empty provider list without a tier match does not fall back to canonical", () => {
  try {
    resetLegacyTelemetry();
    const result = resolveModelForTier("heavy", ["zai/glm-5.2"]);
    assert.equal(result, "zai/glm-5.2");
    assert.equal(getLegacyTelemetry()["legacy.providerDefaultUsed"], 0);
  } finally {
    resetLegacyTelemetry();
  }
});

test("resolveModelForTier: handles provider-prefixed available models", () => {
  const result = resolveModelForTier("heavy", ["anthropic/claude-opus-4-6"]);
  assert.equal(result, "claude-opus-4-6");
});

test("resolveModelForTier: preserves dotted Copilot dispatch spelling", () => {
  const result = resolveModelForTier("heavy", ["github-copilot/claude-opus-4.6"]);
  assert.equal(result, "claude-opus-4.6");
});

test("resolveModelForTier: picks Gemini models when only Google available", () => {
  const result = resolveModelForTier("light", ["gemini-2.5-pro", "gemini-2.0-flash"]);
  assert.equal(result, "gemini-2.0-flash");
});

// ─── Behavioral: profile defaults are provider-agnostic at runtime ──────────

test("resolveProfileDefaults: balanced with only OpenAI models returns OpenAI IDs", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults("balanced", ["gpt-4o", "gpt-4o-mini"]);
  assert.ok(defaults.models, "balanced should populate models");
  // All slots must resolve to an available OpenAI ID — not a claude- canonical.
  for (const [phase, modelId] of Object.entries(defaults.models)) {
    assert.ok(typeof modelId === "string" && modelId.length > 0, `${phase} should resolve to a model ID`);
    assert.ok(
      !String(modelId).startsWith("claude-"),
      `${phase} resolved to ${modelId} but no claude-* model is available — should be OpenAI`,
    );
  }
});

test("resolveProfileDefaults: budget with only OpenAI models picks gpt-4o-mini for light slots", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults("budget", ["gpt-4o", "gpt-4o-mini"]);
  // light-tier slots in budget: research, execution_simple, completion, subagent
  assert.equal(defaults.models?.research, "gpt-4o-mini");
  assert.equal(defaults.models?.execution_simple, "gpt-4o-mini");
  assert.equal(defaults.models?.completion, "gpt-4o-mini");
  assert.equal(defaults.models?.subagent, "gpt-4o-mini");
  // standard-tier slots: planning, execution
  assert.equal(defaults.models?.planning, "gpt-4o");
  assert.equal(defaults.models?.execution, "gpt-4o");
});

test("resolveProfileDefaults: honors dynamic routing tier_models pins", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults(
    "budget",
    ["claude-haiku-4-5", "gpt-4o-mini", "gpt-4o"],
    { ...defaultRoutingConfig(), tier_models: { light: "claude-haiku-4-5" } },
  );
  assert.equal(defaults.models?.research, "claude-haiku-4-5");
  assert.equal(defaults.models?.execution_simple, "claude-haiku-4-5");
  assert.equal(defaults.models?.completion, "claude-haiku-4-5");
  assert.equal(defaults.models?.subagent, "claude-haiku-4-5");
});

test("resolveProfileDefaults: empty availableModelIds falls back to canonical Anthropic IDs", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults("balanced", []);
  // Documented fallback only — when registry is unavailable at bootstrap.
  const planningModel = defaults.models?.planning;
  assert.ok(typeof planningModel === "string" && planningModel.startsWith("claude-"));
});

test("resolveProfileDefaults: empty availableModelIds preserves selected model when provided", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults(
    "balanced",
    [],
    defaultRoutingConfig(),
    "zai/glm-5.2",
  );
  assert.equal(defaults.models?.planning, "zai/glm-5.2");
  assert.equal(defaults.models?.execution, "zai/glm-5.2");
  assert.equal(defaults.models?.completion, "zai/glm-5.2");
  assert.equal(defaults.models?.subagent, "zai/glm-5.2");
});

test("resolveProfileDefaults: selected GLM model wins for standard and light profile slots", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults(
    "balanced",
    ["zai/glm-4.5-air", "zai/glm-5.1", "zai/glm-5.2"],
    defaultRoutingConfig(),
    "zai/glm-5.2",
  );
  assert.equal(defaults.models?.planning, "zai/glm-5.2");
  assert.equal(defaults.models?.execution, "zai/glm-5.2");
  assert.equal(defaults.models?.completion, "zai/glm-5.2");
  assert.equal(defaults.models?.subagent, "zai/glm-5.2");
});

test("loadEffectiveGSDPreferences: balanced profile resolves OpenAI tiers from registry", async () => {
  const oldHome = process.env.GSD_HOME;
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "gsd-profile-registry-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "PREFERENCES.md"), "---\ntoken_profile: balanced\n---\n");
    const { loadEffectiveGSDPreferences, modelIdsForProfileResolution } = await import("../preferences.ts");
    const registry = {
      getAvailable: () => [
        { provider: "google", id: "gemini-2.0-flash" },
        { provider: "openai-codex", id: "gpt-4o" },
        { provider: "openai-codex", id: "gpt-4o-mini" },
      ],
    };
    const scopedIds = modelIdsForProfileResolution(registry, "openai-codex");
    const loaded = loadEffectiveGSDPreferences(undefined, {
      availableModelIds: scopedIds,
    });
    const models = loaded?.preferences.models as Record<string, string> | undefined;
    assert.equal(models?.planning, "gpt-4o");
    assert.equal(models?.execution, "gpt-4o");
    assert.equal(models?.completion, "gpt-4o-mini");
    assert.equal(models?.subagent, "gpt-4o-mini");
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadEffectiveGSDPreferences: implicit balanced (D046) resolves tiers from registry", async () => {
  const oldHome = process.env.GSD_HOME;
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "gsd-profile-implicit-balanced-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "PREFERENCES.md"), "---\nmode: solo\n---\n");
    const { loadEffectiveGSDPreferencesWithRegistry } = await import("../preferences.ts");
    const registry = {
      getAvailable: () => [
        { provider: "google", id: "gemini-2.0-flash" },
        { provider: "openai-codex", id: "gpt-4o" },
        { provider: "openai-codex", id: "gpt-4o-mini" },
      ],
    };
    const loaded = loadEffectiveGSDPreferencesWithRegistry(registry, undefined, "openai-codex");
    const models = loaded?.preferences.models as Record<string, string> | undefined;
    assert.equal(models?.planning, "gpt-4o");
    assert.equal(models?.completion, "gpt-4o-mini");
    assert.notEqual(models?.completion, "gemini-2.0-flash");
    assert.equal(
      loaded?.preferences.phases?.skip_slice_research,
      undefined,
      "implicit balanced model defaults must not silently skip slice research",
    );
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadEffectiveGSDPreferences: implicit balanced preserves selected GLM model", async () => {
  const oldHome = process.env.GSD_HOME;
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "gsd-profile-selected-glm-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "PREFERENCES.md"), "---\nmode: solo\n---\n");
    const { loadEffectiveGSDPreferencesWithRegistry } = await import("../preferences.ts");
    const registry = {
      getAvailable: () => [
        { provider: "zai", id: "glm-4.5-air" },
        { provider: "zai", id: "glm-5.1" },
        { provider: "zai", id: "glm-5.2" },
      ],
    };
    const loaded = loadEffectiveGSDPreferencesWithRegistry(registry, undefined, "zai", "zai/glm-5.2");
    const models = loaded?.preferences.models as Record<string, string> | undefined;
    assert.equal(models?.planning, "zai/glm-5.2");
    assert.equal(models?.execution, "zai/glm-5.2");
    assert.equal(models?.completion, "zai/glm-5.2");
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadEffectiveGSDPreferences: implicit balanced preserves selected model when scoped registry is empty", async () => {
  const oldHome = process.env.GSD_HOME;
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "gsd-profile-empty-scope-selected-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "PREFERENCES.md"), "---\nmode: solo\n---\n");
    const { loadEffectiveGSDPreferencesWithRegistry } = await import("../preferences.ts");
    const registry = {
      getAvailable: () => [
        { provider: "google", id: "gemini-2.0-flash" },
        { provider: "openai-codex", id: "gpt-4o" },
      ],
    };
    const loaded = loadEffectiveGSDPreferencesWithRegistry(registry, undefined, "zai", "zai/glm-5.2");
    const models = loaded?.preferences.models as Record<string, string> | undefined;
    assert.equal(models?.planning, "zai/glm-5.2");
    assert.equal(models?.execution, "zai/glm-5.2");
    assert.equal(models?.completion, "zai/glm-5.2");
    assert.equal(models?.subagent, "zai/glm-5.2");
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadEffectiveGSDPreferences: implicit balanced preserves selected model when registry is missing", async () => {
  const oldHome = process.env.GSD_HOME;
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "gsd-profile-missing-registry-selected-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "PREFERENCES.md"), "---\nmode: solo\n---\n");
    const { loadEffectiveGSDPreferencesWithRegistry } = await import("../preferences.ts");
    const loaded = loadEffectiveGSDPreferencesWithRegistry(undefined, undefined, undefined, "zai/glm-5.2");
    const models = loaded?.preferences.models as Record<string, string> | undefined;
    assert.equal(models?.planning, "zai/glm-5.2");
    assert.equal(models?.execution, "zai/glm-5.2");
    assert.equal(models?.completion, "zai/glm-5.2");
    assert.equal(models?.subagent, "zai/glm-5.2");
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("modelIdsForProfileResolution: empty anchor scope does not fall back to other providers", async () => {
  const { modelIdsForProfileResolution } = await import("../preferences.ts");
  const registry = {
    getAvailable: () => [
      { provider: "google", id: "gemini-2.0-flash" },
      { provider: "openai-codex", id: "gpt-4o" },
    ],
  };
  const scoped = modelIdsForProfileResolution(registry, "openai-codex");
  assert.deepEqual(scoped, ["openai-codex/gpt-4o"]);
  const emptyAnchor = modelIdsForProfileResolution(registry, "anthropic");
  assert.deepEqual(emptyAnchor, []);
});

test("modelIdsForProfileResolution: honors disabled_model_providers", async () => {
  const oldHome = process.env.GSD_HOME;
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "gsd-profile-disabled-google-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(
      join(home, "PREFERENCES.md"),
      "---\ndisabled_model_providers:\n  - google\n---\n",
    );
    const { modelIdsForProfileResolution, resolveDisabledModelProvidersFromPreferences } = await import("../preferences.ts");
    const registry = {
      getAvailable: () => [
        { provider: "google", id: "gemini-2.0-flash" },
        { provider: "openai-codex", id: "gpt-4o" },
      ],
    };
    const disabled = resolveDisabledModelProvidersFromPreferences();
    const ids = modelIdsForProfileResolution(registry, undefined, disabled);
    assert.deepEqual(ids, ["openai-codex/gpt-4o"]);
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadEffectiveGSDPreferences: anchor provider ignores cheaper Gemini when OpenAI is active", async () => {
  const oldHome = process.env.GSD_HOME;
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "gsd-profile-anchor-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "PREFERENCES.md"), "---\ntoken_profile: balanced\n---\n");
    const { loadEffectiveGSDPreferencesWithRegistry } = await import("../preferences.ts");
    const registry = {
      getAvailable: () => [
        { provider: "google", id: "gemini-2.0-flash" },
        { provider: "openai-codex", id: "gpt-4o" },
        { provider: "openai-codex", id: "gpt-4o-mini" },
      ],
    };
    const loaded = loadEffectiveGSDPreferencesWithRegistry(registry, undefined, "openai-codex");
    const models = loaded?.preferences.models as Record<string, string> | undefined;
    assert.equal(models?.planning, "gpt-4o");
    assert.notEqual(models?.completion, "gemini-2.0-flash");
    assert.equal(models?.completion, "gpt-4o-mini");
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveProfileDefaults: burn-max omits models so user choice is preserved", async () => {
  const { resolveProfileDefaults } = await import("../preferences-models.js");
  const defaults = resolveProfileDefaults("burn-max", ["gpt-4o"]);
  assert.equal(defaults.models, undefined, "burn-max must not write model defaults");
  assert.equal(defaults.dynamic_routing?.enabled, false);
});

// ─── Capability Scoring (ADR-004 Phase 2) ───────────────────────────────────

test("defaultRoutingConfig includes capability_routing: true", () => {
  const config = defaultRoutingConfig();
  assert.equal(config.capability_routing, true);
});

test("scoreEligibleModels uses bare capability profiles for provider-qualified IDs", () => {
  const scored = scoreEligibleModels(
    ["custom-openai/gpt-5.4", "custom-openai/gpt-5.3-codex-spark"],
    { coding: 1 },
  );

  assert.equal(scored[0]?.modelId, "custom-openai/gpt-5.4");
  assert.ok(
    (scored[0]?.score ?? 0) > (scored[1]?.score ?? 0),
    "provider-qualified IDs should still use the built-in bare model capability profile",
  );
});

test("scoreEligibleModels uses canonical profiles for dotted GitHub Copilot Claude IDs", () => {
  const scored = scoreEligibleModels(
    ["github-copilot/claude-sonnet-4.6", "unknown/model"],
    { coding: 1 },
  );

  assert.equal(scored[0]?.modelId, "github-copilot/claude-sonnet-4.6");
  assert.equal(scored[0]?.score, MODEL_CAPABILITY_PROFILES["claude-sonnet-4-6"].coding);
});

test("scoreEligibleModels honors dotted bare-ID capability overrides", () => {
  const scored = scoreEligibleModels(
    ["github-copilot/claude-sonnet-4.6", "gpt-4o"],
    { coding: 1 },
    { "claude-sonnet-4.6": { coding: 30 } },
  );

  assert.equal(scored[0]?.modelId, "gpt-4o");
});

test("scoreEligibleModels uses canonical costs for provider-qualified dotted IDs", () => {
  const scored = scoreEligibleModels(
    ["github-copilot/claude-opus-4.6", "gpt-5"],
    {},
  );

  assert.equal(scored[0]?.modelId, "github-copilot/claude-opus-4.6");
});

test("all cataloged GitHub Copilot Claude aliases have tiers and capability profiles", () => {
  const aliases: Array<[string, "light" | "standard" | "heavy"]> = [
    ["claude-haiku-4.5", "light"],
    ["claude-opus-4.5", "heavy"],
    ["claude-opus-4.6", "heavy"],
    ["claude-opus-4.7", "heavy"],
    ["claude-opus-4.8", "heavy"],
    ["claude-sonnet-4", "standard"],
    ["claude-sonnet-4.5", "standard"],
    ["claude-sonnet-4.6", "standard"],
  ];

  for (const [alias, tier] of aliases) {
    const qualified = `github-copilot/${alias}`;
    assert.deepEqual(getEligibleModels(tier, [qualified], defaultRoutingConfig()), [qualified]);
    assert.notEqual(scoreEligibleModels([qualified], { coding: 1 })[0]?.score, 50);
  }
});

test("scoreModel computes weighted average of capability × requirement", () => {
  const caps: ModelCapabilities = {
    coding: 90, debugging: 80, research: 70,
    reasoning: 85, speed: 50, longContext: 60, instruction: 75,
  };
  const reqs = { coding: 0.9, reasoning: 0.5 };
  const score = scoreModel(caps, reqs);
  // Expected: (0.9*90 + 0.5*85) / (0.9 + 0.5) = (81 + 42.5) / 1.4 = 88.21...
  assert.ok(Math.abs(score - 88.21) < 0.1, `score ${score} should be ~88.21`);
});

// (Removed duplicate "scoreModel returns 50 for empty requirements" — the
// `describe("scoreModel")` block below has the same scenario.)

test("computeTaskRequirements returns base vector for known unit type", () => {
  const reqs = computeTaskRequirements("execute-task");
  assert.ok(reqs.coding !== undefined && reqs.coding > 0);
});

test("computeTaskRequirements boosts instruction for docs-tagged tasks", () => {
  const reqs = computeTaskRequirements("execute-task", { tags: ["docs"] });
  assert.ok((reqs.instruction ?? 0) >= 0.8);
  assert.ok((reqs.coding ?? 1) <= 0.4);
});

test("computeTaskRequirements returns generic vector for unknown unit type", () => {
  const reqs = computeTaskRequirements("unknown-unit");
  assert.ok(reqs.reasoning !== undefined);
});

test("resolveModelForComplexity uses capability scoring when enabled", () => {
  const config: DynamicRoutingConfig = {
    ...defaultRoutingConfig(),
    enabled: true,
    capability_routing: true,
  };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["claude-opus-4-6", "claude-haiku-4-5", "gpt-4o-mini"],
    "execute-task",
  );
  assert.equal(result.wasDowngraded, true);
  assert.equal(result.selectionMethod, "capability-scored");
});

test("resolveModelForComplexity falls back to tier-only when capability_routing is false", () => {
  const config: DynamicRoutingConfig = {
    ...defaultRoutingConfig(),
    enabled: true,
    capability_routing: false,
  };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["claude-opus-4-6", "claude-haiku-4-5", "gpt-4o-mini"],
  );
  assert.equal(result.wasDowngraded, true);
  assert.ok(!result.selectionMethod || result.selectionMethod === "tier-only");
});

test("MODEL_CAPABILITY_PROFILES has entries for all tier-mapped models", () => {
  const profiledModels = Object.keys(MODEL_CAPABILITY_PROFILES);
  assert.ok(profiledModels.length >= 30, `Expected ≥30 profiles, got ${profiledModels.length}`);
  assert.ok(MODEL_CAPABILITY_PROFILES["claude-opus-4-6"]);
  assert.ok(MODEL_CAPABILITY_PROFILES["claude-haiku-4-5"]);
});

// ─── #2885: openai-codex and modern OpenAI models in tier map ────────────────

test("#2885: openai-codex light-tier models are recognized", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const lightModels = ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-5-mini", "gpt-5-nano", "gpt-5.1-codex-mini", "gpt-5.3-codex-spark", "gpt-5.4-mini"];
  for (const model of lightModels) {
    const result = resolveModelForComplexity(
      makeClassification("light"),
      { primary: model, fallbacks: [] },
      config,
      [model, ...AVAILABLE_MODELS],
    );
    // Model is known AND light-tier, so requesting light should NOT downgrade
    assert.equal(result.wasDowngraded, false, `${model} should be known as light tier (wasDowngraded)`);
    assert.equal(result.modelId, model, `${model} should be returned as-is for light tier`);
    // Verify it IS known (not hitting the unknown-model bail-out)
    assert.ok(!result.reason.includes("not in the known tier map"), `${model} should be in the known tier map`);
  }
});

test("#2885: openai-codex standard-tier models are recognized", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const standardModels = ["gpt-4.1", "gpt-5.1-codex-max"];
  for (const model of standardModels) {
    const result = resolveModelForComplexity(
      makeClassification("standard"),
      { primary: model, fallbacks: [] },
      config,
      [model, ...AVAILABLE_MODELS],
    );
    assert.equal(result.wasDowngraded, false, `${model} should be known as standard tier`);
    assert.equal(result.modelId, model, `${model} should be returned as-is for standard tier`);
    assert.ok(!result.reason.includes("not in the known tier map"), `${model} should be in the known tier map`);
  }
});

test("#2885: openai-codex heavy-tier models are recognized", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const heavyModels = ["gpt-5", "gpt-5-pro", "gpt-5.1", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "o4-mini", "o4-mini-deep-research"];
  for (const model of heavyModels) {
    const result = resolveModelForComplexity(
      makeClassification("heavy"),
      { primary: model, fallbacks: [] },
      config,
      [model, ...AVAILABLE_MODELS],
    );
    assert.equal(result.wasDowngraded, false, `${model} should be known as heavy tier`);
    assert.equal(result.modelId, model, `${model} should be returned as-is for heavy tier`);
    assert.ok(!result.reason.includes("not in the known tier map"), `${model} should be in the known tier map`);
  }
});

test("#2885: heavy openai-codex model downgrades to light for light task", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "gpt-5.4", fallbacks: [] },
    config,
    ["gpt-5.4", "gpt-4.1-nano", ...AVAILABLE_MODELS],
  );
  assert.equal(result.wasDowngraded, true, "heavy model should downgrade for light task");
  // Should pick a light-tier model
  assert.notEqual(result.modelId, "gpt-5.4", "should not use the heavy model for light task");
});
// ─── scoreModel ──────────────────────────────────────────────────────────────

describe("scoreModel", () => {
  const sonnetProfile: ModelCapabilities = MODEL_CAPABILITY_PROFILES["claude-sonnet-4-6"];

  test("produces correct weighted average for two dimensions (coding:0.9, instruction:0.7)", () => {
    // (0.9*85 + 0.7*85) / (0.9+0.7) = (76.5+59.5)/1.6 = 136/1.6 = 85.0
    const score = scoreModel(sonnetProfile, { coding: 0.9, instruction: 0.7 });
    assert.ok(Math.abs(score - 85.0) < 0.01, `Expected ~85.0, got ${score}`);
  });

  test("returns 50 when requirements is empty", () => {
    const score = scoreModel(sonnetProfile, {});
    assert.equal(score, 50);
  });

  test("returns correct score for single dimension coding:1.0", () => {
    // coding=90 for claude-opus-4-6
    const opusProfile = MODEL_CAPABILITY_PROFILES["claude-opus-4-6"];
    const score = scoreModel(opusProfile, { coding: 1.0 });
    assert.equal(score, 95);
  });

  test("handles all 7 dimensions correctly", () => {
    // Uniform weight 1.0 on every dim → average of all dim values
    const profile: ModelCapabilities = {
      coding: 60, debugging: 60, research: 60, reasoning: 60,
      speed: 60, longContext: 60, instruction: 60,
    };
    const reqs: Partial<Record<keyof ModelCapabilities, number>> = {
      coding: 1.0, debugging: 1.0, research: 1.0, reasoning: 1.0,
      speed: 1.0, longContext: 1.0, instruction: 1.0,
    };
    const score = scoreModel(profile, reqs);
    assert.equal(score, 60);
  });
});

// ─── computeTaskRequirements ─────────────────────────────────────────────────

describe("computeTaskRequirements", () => {
  test("execute-task with no metadata returns base vector", () => {
    const req = computeTaskRequirements("execute-task", undefined);
    assert.deepStrictEqual(req, { coding: 0.9, instruction: 0.7, speed: 0.3 });
  });

  test("execute-task with tags:['docs'] adjusts requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["docs"] });
    assert.equal(req.instruction, 0.9);
    assert.equal(req.coding, 0.3);
    assert.equal(req.speed, 0.7);
  });

  test("execute-task with tags:['config'] adjusts requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["config"] });
    assert.equal(req.instruction, 0.9);
  });

  test("execute-task with complexityKeywords:['concurrency'] boosts debugging and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["concurrency"] });
    assert.equal(req.debugging, 0.9);
    assert.equal(req.reasoning, 0.8);
  });

  test("execute-task with complexityKeywords:['migration'] boosts reasoning and coding", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["migration"] });
    assert.equal(req.reasoning, 0.9);
    assert.equal(req.coding, 0.8);
  });

  test("execute-task with fileCount:8 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { fileCount: 8 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });

  test("execute-task with estimatedLines:600 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { estimatedLines: 600 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });

  test("research-milestone returns correct base vector", () => {
    const req = computeTaskRequirements("research-milestone");
    assert.deepStrictEqual(req, { research: 0.9, longContext: 0.7, reasoning: 0.5 });
  });

  test("plan-slice returns correct base vector", () => {
    const req = computeTaskRequirements("plan-slice");
    assert.deepStrictEqual(req, { reasoning: 0.9, coding: 0.5 });
  });

  test("unknown-unit-type returns default reasoning requirement", () => {
    const req = computeTaskRequirements("unknown-unit-type");
    assert.deepStrictEqual(req, { reasoning: 0.5 });
  });

  test("non-execute-task with metadata ignores metadata refinements", () => {
    // research-milestone should return the same vector regardless of metadata
    const reqWithMeta = computeTaskRequirements("research-milestone", { tags: ["docs"], fileCount: 10 });
    const reqWithout = computeTaskRequirements("research-milestone");
    assert.deepStrictEqual(reqWithMeta, reqWithout);
  });
});

// ─── scoreEligibleModels ─────────────────────────────────────────────────────

describe("scoreEligibleModels", () => {
  test("ranks models by score descending when scores differ by more than 2", () => {
    // research: heavily weights research dimension. gemini-2.5-pro has 85 research vs sonnet's 75
    const requirements = { research: 0.9, longContext: 0.7, reasoning: 0.5 };
    const results = scoreEligibleModels(["claude-sonnet-4-6", "gemini-2.5-pro"], requirements);
    assert.equal(results.length, 2);
    assert.ok(results[0].score >= results[1].score, "Should be sorted by score descending");
  });

  test("within 2-point threshold, prefers cheaper model", () => {
    // Use models without built-in profiles (both get score 50) so tie-break applies
    // Then use known models with equal scores: force this via single unknown model pair
    const requirements = { coding: 1.0 };
    // model-a and model-b are both unknown → score=50, cost=Infinity → lexicographic
    const results = scoreEligibleModels(["model-z", "model-a"], requirements);
    // Both unknown: score=50 (within 2), cost=Infinity (equal) → lex: model-a first
    assert.equal(results[0].modelId, "model-a");
  });

  test("single model returns array of one", () => {
    const results = scoreEligibleModels(["claude-sonnet-4-6"], { coding: 0.9 });
    assert.equal(results.length, 1);
    assert.equal(results[0].modelId, "claude-sonnet-4-6");
  });

  test("unknown model with no profile gets score of 50", () => {
    const results = scoreEligibleModels(["totally-unknown-model"], { coding: 1.0 });
    assert.equal(results[0].score, 50);
  });

  test("capabilityOverrides deep-merges with built-in profile", () => {
    const requirements = { coding: 1.0 };
    // Override sonnet's coding to 30 — gpt-4o (coding=80) should win
    const results = scoreEligibleModels(
      ["claude-sonnet-4-6", "gpt-4o"],
      requirements,
      { "claude-sonnet-4-6": { coding: 30 } },
    );
    assert.equal(results[0].modelId, "gpt-4o", "gpt-4o should rank first after coding override");
  });
});

// ─── getEligibleModels ───────────────────────────────────────────────────────

describe("getEligibleModels", () => {
  const ALL_MODELS = [
    "claude-opus-4-6",   // heavy
    "claude-sonnet-4-6", // standard
    "claude-haiku-4-5",  // light
    "gpt-4o-mini",       // light
    "gpt-4o",            // standard
  ];

  test("returns light-tier models from available list sorted by cost", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    const result = getEligibleModels("light", ALL_MODELS, config);
    assert.ok(result.length >= 1);
    for (const id of result) {
      assert.ok(
        ["claude-haiku-4-5", "gpt-4o-mini"].includes(id),
        `Expected light-tier model, got ${id}`,
      );
    }
  });

  test("returns standard-tier models from available list sorted by cost", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    const result = getEligibleModels("standard", ALL_MODELS, config);
    assert.ok(result.length >= 1);
    for (const id of result) {
      assert.ok(
        ["claude-sonnet-4-6", "gpt-4o"].includes(id),
        `Expected standard-tier model, got ${id}`,
      );
    }
  });

  test("tier_models pinned model returns single-element array", () => {
    const config: DynamicRoutingConfig = {
      ...defaultRoutingConfig(),
      tier_models: { light: "gpt-4o-mini" },
    };
    const result = getEligibleModels("light", ALL_MODELS, config);
    assert.deepStrictEqual(result, ["gpt-4o-mini"]);
  });

  test("empty available list returns empty array", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    const result = getEligibleModels("light", [], config);
    assert.equal(result.length, 0);
  });

  test("unknown models classified as standard appear in standard tier results", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    // unknown-model-xyz has no entry → defaults to standard tier
    const result = getEligibleModels("standard", ["unknown-model-xyz"], config);
    assert.ok(result.includes("unknown-model-xyz"), "Unknown model should appear in standard tier");
  });
});

// ─── capability-aware routing integration ────────────────────────────────────

describe("capability-aware routing integration", () => {
  // All standard-tier models available alongside heavy (opus)
  const MULTI_MODEL_AVAILABLE = [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gpt-4o",
    "gemini-2.5-pro",
    "claude-haiku-4-5",
    "gpt-4o-mini",
  ];

  // 1. Full pipeline with capability scoring active
  test("full pipeline with capability_routing: true returns capability-scored decision", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    // Configured primary is opus (heavy) — standard tier should trigger capability scoring
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      { tags: [], complexityKeywords: [], fileCount: 3, estimatedLines: 100, codeBlockCount: 0 },
    );
    assert.equal(result.selectionMethod, "capability-scored", "should use capability scoring when enabled with multiple eligible models");
    assert.ok(result.capabilityScores !== undefined, "capabilityScores should be populated");
    assert.ok(Object.keys(result.capabilityScores ?? {}).length > 1, "should have scores for multiple models");
    assert.equal(result.wasDowngraded, true, "should be downgraded from opus");
  });

  // 2. capability_routing: false falls back to tier-only
  test("capability_routing: false skips scoring and uses tier-only", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: false };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      undefined,
    );
    assert.equal(result.selectionMethod, "tier-only", "capability_routing: false should use tier-only");
    assert.equal(result.capabilityScores, undefined, "capabilityScores should be undefined for tier-only");
  });

  // 3. Single eligible model skips scoring
  test("single eligible model skips capability scoring and uses tier-only", () => {
    const config: DynamicRoutingConfig = {
      ...defaultRoutingConfig(),
      enabled: true,
      capability_routing: true,
      tier_models: { standard: "claude-sonnet-4-6" },
    };
    // Pin to single standard model — eligible.length === 1 → skips STEP 2
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      undefined,
    );
    // Single pinned model → tier-only (no scoring needed)
    assert.equal(result.selectionMethod, "tier-only", "single eligible model should use tier-only");
    assert.equal(result.modelId, "claude-sonnet-4-6", "should use the pinned model");
  });

  // 4. Unknown model with no profile gets uniform 50s and competes
  test("unknown model with no profile gets uniform score of 50 and can compete", () => {
    const unknownModel = "unknown-future-model-xyz";
    // Add unknown model to available list at standard tier (unknown → standard per D-15)
    // scoring should still work with score=50 for the unknown model
    const requirements = { coding: 0.9, instruction: 0.7, speed: 0.3 };
    const scored = scoreEligibleModels([unknownModel, "claude-sonnet-4-6"], requirements);
    const unknownEntry = scored.find(s => s.modelId === unknownModel);
    assert.ok(unknownEntry !== undefined, "unknown model should be in scored results");
    // Unknown model gets uniform 50s: (0.9*50 + 0.7*50 + 0.3*50) / (0.9+0.7+0.3) ≈ 50
    assert.ok(Math.abs(unknownEntry.score - 50) < 0.01, `expected score ~50, got ${unknownEntry.score}`);
  });

  // 5. Capability overrides change scoring outcome
  test("capabilityOverrides boost a model above another for same task", () => {
    // sonnet: coding=85, gpt-4o: coding=80. Override gpt-4o coding to 99 → gpt-4o should win.
    const requirements = { coding: 1.0 };
    const overrides = { "gpt-4o": { coding: 99 } };
    const scored = scoreEligibleModels(["claude-sonnet-4-6", "gpt-4o"], requirements, overrides);
    assert.equal(scored[0].modelId, "gpt-4o", "overridden model should win for coding-heavy task");
    assert.ok(scored[0].score > 90, `expected score > 90 after override, got ${scored[0].score}`);
  });

  // 5b. Capability overrides pass through resolveModelForComplexity to scoreEligibleModels
  test("resolveModelForComplexity passes capabilityOverrides to scoring step", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    // sonnet coding=85, gpt-4o coding=80. Override gpt-4o coding to 99 → gpt-4o should win.
    const overrides: Record<string, Partial<ModelCapabilities>> = { "gpt-4o": { coding: 99 } };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-4o"],
      "execute-task",
      undefined,
      overrides,
    );
    assert.equal(result.selectionMethod, "capability-scored");
    assert.equal(result.modelId, "gpt-4o", "gpt-4o should win with coding override");
  });

  // 6. Regression: existing routing guards unchanged
  test("regression: routing-disabled passthrough still returns tier-only", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: false };
    const result = resolveModelForComplexity(
      { tier: "light", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      undefined,
    );
    assert.equal(result.selectionMethod, "tier-only");
    assert.equal(result.wasDowngraded, false);
    assert.equal(result.modelId, "claude-opus-4-6");
  });

  test("regression: unknown-model bypass returns tier-only and does not downgrade", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      { tier: "light", reason: "test", downgraded: false },
      { primary: "totally-unknown-custom-model", fallbacks: [] },
      config,
      ["totally-unknown-custom-model", ...MULTI_MODEL_AVAILABLE],
      "execute-task",
      undefined,
    );
    assert.equal(result.selectionMethod, "tier-only");
    assert.equal(result.wasDowngraded, false);
    assert.equal(result.modelId, "totally-unknown-custom-model");
  });

  test("regression: no-downgrade-needed path returns tier-only", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    // Configured model is sonnet (standard), requesting standard → no downgrade needed
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-sonnet-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      undefined,
    );
    assert.equal(result.selectionMethod, "tier-only");
    assert.equal(result.wasDowngraded, false);
    assert.equal(result.modelId, "claude-sonnet-4-6");
  });
});

// ─── getModelTier unknown default ────────────────────────────────────────────

describe("getModelTier unknown default", () => {
  test("unknown model returns standard tier (not heavy) via downgrade behavior", () => {
    // We can verify this indirectly: resolveModelForComplexity for a standard classification
    // with an unknown primary model should NOT downgrade (because unknown → standard, not heavy)
    const config = { ...defaultRoutingConfig(), enabled: true };
    // Use "unknown-model-xyz" as primary — its tier will be "standard" per D-15
    // Classification is "heavy" → tier >= standard → no downgrade
    // But unknown models use the isKnownModel() guard, so they pass through anyway
    // Test the positive: an unknown model is NOT treated as heavy
    const result = resolveModelForComplexity(
      makeClassification("standard"),
      { primary: "claude-sonnet-4-6", fallbacks: [] },
      config,
      ["claude-sonnet-4-6", "claude-haiku-4-5", "gpt-4o-mini"],
    );
    // standard classification with standard model (sonnet) → no downgrade
    assert.equal(result.wasDowngraded, false, "standard model should not downgrade for standard task");
    assert.equal(result.modelId, "claude-sonnet-4-6");
  });

  test("unknown model in getEligibleModels warns and defaults to standard tier", (t) => {
    // Per D-15: getModelTier returns "standard" for unknown models
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    const warnings: string[] = [];
    t.mock.method(console, "warn", (message: string) => warnings.push(message));
    const standardModels = getEligibleModels("standard", ["totally-unknown-model-abc"], config);
    const lightModels = getEligibleModels("light", ["totally-unknown-model-abc"], config);
    const heavyModels = getEligibleModels("heavy", ["totally-unknown-model-abc"], config);
    assert.ok(standardModels.includes("totally-unknown-model-abc"), "Unknown model should be in standard tier");
    assert.equal(lightModels.length, 0, "Unknown model should NOT be in light tier");
    assert.equal(heavyModels.length, 0, "Unknown model should NOT be in heavy tier");
    assert.equal(warnings.length, 1, "unknown routing warnings should be deduplicated by canonical ID");
    assert.match(warnings[0] ?? "", /safe defaults.*standard tier.*neutral capabilities.*expensive cost/i);
  });
});

// --- claude-sonnet-5 catalog regression (v1.12.0 gap) ---
// Discovered during Edelman Studio M010 model-routing config: claude-sonnet-5 was
// absent from MODEL_CAPABILITY_TIER, causing isKnownModel() to return false and
// the #2192 routing-bypass path to activate for any phase configured with sonnet-5.

test("claude-sonnet-5 is classified as standard tier in MODEL_CAPABILITY_TIER", () => {
  assert.equal(
    MODEL_CAPABILITY_TIER["claude-sonnet-5"],
    "standard",
    "claude-sonnet-5 must be in the tier map so isKnownModel() returns true",
  );
});

test("claude-sonnet-5 as ceiling: standard task is NOT bypassed - routing applies normally", () => {
  // With sonnet-5 now a known model, resolveModelForComplexity must NOT hit the
  // #2192 bail-out. A standard task with a sonnet-5 ceiling should stay on sonnet-5.
  const config = {
    ...defaultRoutingConfig(),
    enabled: true,
    tier_models: { light: "claude-haiku-4-5", standard: "claude-sonnet-5", heavy: "claude-opus-4-8" },
  };
  const result = resolveModelForComplexity(
    { tier: "standard", reason: "test", downgraded: false },
    { primary: "claude-sonnet-5", fallbacks: [] },
    config,
    ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"],
  );
  assert.equal(result.modelId, "claude-sonnet-5", "standard task with sonnet-5 ceiling should use sonnet-5");
  assert.equal(result.wasDowngraded, false, "should not be downgraded when task tier matches ceiling");
  assert.ok(!result.reason?.includes("not in the known tier map"), "must not hit #2192 bypass reason");
});

test("claude-sonnet-5 as ceiling: light task IS downgraded to haiku - routing not bypassed", () => {
  // Confirms that with sonnet-5 as a known model, dynamic routing correctly
  // downgrades light tasks to tier_models.light (haiku) instead of bypassing.
  const config = {
    ...defaultRoutingConfig(),
    enabled: true,
    tier_models: { light: "claude-haiku-4-5", standard: "claude-sonnet-5", heavy: "claude-opus-4-8" },
  };
  const result = resolveModelForComplexity(
    { tier: "light", reason: "test", downgraded: false },
    { primary: "claude-sonnet-5", fallbacks: [] },
    config,
    ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"],
  );
  assert.equal(result.modelId, "claude-haiku-4-5", "light task with sonnet-5 ceiling must downgrade to haiku");
  assert.equal(result.wasDowngraded, true);
});

// --- claude-opus-5 catalog coverage (upstream #1588) ---
// claude-opus-5 must be present in the capability registries so isKnownModel()
// returns true and routing decisions are not bypassed via the #2192 path.

test("claude-opus-5 is classified as heavy tier in MODEL_CAPABILITY_TIER", () => {
  assert.equal(
    MODEL_CAPABILITY_TIER["claude-opus-5"],
    "heavy",
    "claude-opus-5 must be in the tier map so isKnownModel() returns true",
  );
});

test("claude-opus-5 as ceiling: heavy task is NOT bypassed - routing applies normally", () => {
  const config = {
    ...defaultRoutingConfig(),
    enabled: true,
    tier_models: { light: "claude-haiku-4-5", standard: "claude-sonnet-5", heavy: "claude-opus-5" },
  };
  const result = resolveModelForComplexity(
    { tier: "heavy", reason: "test", downgraded: false },
    { primary: "claude-opus-5", fallbacks: [] },
    config,
    ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
  );
  assert.equal(result.modelId, "claude-opus-5", "heavy task with opus-5 ceiling should use opus-5");
  assert.equal(result.wasDowngraded, false, "should not be downgraded when task tier matches ceiling");
  assert.ok(!result.reason?.includes("not in the known tier map"), "must not hit #2192 bypass reason");
});

test("claude-opus-5 as ceiling: light task IS downgraded to haiku - routing not bypassed", () => {
  const config = {
    ...defaultRoutingConfig(),
    enabled: true,
    tier_models: { light: "claude-haiku-4-5", standard: "claude-sonnet-5", heavy: "claude-opus-5" },
  };
  const result = resolveModelForComplexity(
    { tier: "light", reason: "test", downgraded: false },
    { primary: "claude-opus-5", fallbacks: [] },
    config,
    ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
  );
  assert.equal(result.modelId, "claude-haiku-4-5", "light task with opus-5 ceiling must downgrade to haiku");
  assert.equal(result.wasDowngraded, true);
});

// ─── Duplicate registry keys (#1707 regression) ──────────────────────────────
// The Sonnet 5 rollout appended a second "claude-sonnet-5" entry to three
// registries (MODEL_CAPABILITY_TIER, MODEL_COST_PER_1K_INPUT,
// MODEL_CAPABILITY_PROFILES) instead of editing the existing rows. Duplicate
// object-literal keys are a hard TypeScript error (TS1117), so `pnpm build`
// failed with three diagnostics. Runtime behavior cannot observe a duplicate
// key (the last assignment silently wins), so the regression test walks the
// module's real object literals through the TypeScript AST.

describe("model-router registry keys", () => {
  test("no object literal declares the same key twice (TS1117)", () => {
    const routerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "model-router.ts");
    // allow-source-grep: AST structural linter for duplicate object-literal
    // keys; it walks real PropertyAssignment nodes, not source text.
    const source = ts.createSourceFile(
      routerPath,
      readFileSync(routerPath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );

    const duplicates: string[] = [];

    function keyOf(prop: ts.ObjectLiteralElementLike): string | undefined {
      if (!ts.isPropertyAssignment(prop)) return undefined;
      const name = prop.name;
      if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
      if (ts.isIdentifier(name)) return name.text;
      return undefined;
    }

    function visit(node: ts.Node): void {
      if (ts.isObjectLiteralExpression(node)) {
        const seen = new Set<string>();
        for (const prop of node.properties) {
          const key = keyOf(prop);
          if (!key) continue;
          if (seen.has(key)) {
            const { line } = source.getLineAndCharacterOfPosition(prop.getStart(source));
            duplicates.push(`${key} (line ${line + 1})`);
          }
          seen.add(key);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source);

    assert.deepEqual(
      duplicates,
      [],
      `model-router.ts declares duplicate object-literal keys, which fails the build with TS1117: ${duplicates.join(", ")}`,
    );
  });

  test("claude-sonnet-5 keeps one consistent entry across tier, cost, and capability registries", () => {
    assert.equal(MODEL_CAPABILITY_TIER["claude-sonnet-5"], "standard");
    assert.deepEqual(MODEL_CAPABILITY_PROFILES["claude-sonnet-5"], {
      coding: 90,
      debugging: 85,
      research: 80,
      reasoning: 87,
      speed: 55,
      longContext: 80,
      instruction: 88,
    });
    // The cost table is module-private; observe its sonnet-5 row through the
    // cheapest-first ordering of standard-tier eligibility (0.003 vs 0.00125).
    assert.deepEqual(
      getEligibleModels("standard", ["claude-sonnet-5", "gemini-2.5-pro"], defaultRoutingConfig()),
      ["gemini-2.5-pro", "claude-sonnet-5"],
    );
  });

  test("all bundled GitHub Copilot chat models have router tier and capability profiles", () => {
    const catalogPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "packages", "pi-ai", "src", "models.generated.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"))["github-copilot"] as Record<string, Model<Api>>;
    const missing = Object.values(catalog)
      .filter((model) => model.api === "openai-completions" || model.api === "openai-responses" || model.api === "anthropic-messages")
      .map((model) => canonicalizeModelId(model.id))
      .filter((modelId) => MODEL_CAPABILITY_TIER[modelId] === undefined || MODEL_CAPABILITY_PROFILES[modelId] === undefined)
      .sort();

    assert.deepEqual(missing, []);
  });
});

describe("Phase J routing safety", () => {
  test("getModelProfileConfidence classifies curated, provisional, and unknown", () => {
    assert.equal(getModelProfileConfidence("gpt-4o"), "curated");
    assert.equal(getModelProfileConfidence("openai/gpt-4o"), "curated");
    assert.equal(getModelProfileConfidence("brand-new-unreleased-model"), "unknown");
    assert.equal(
      getModelProfileConfidence("brand-new-unreleased-model", {
        "brand-new-unreleased-model": { coding: 72, reasoning: 68, speed: 74, debugging: 60, research: 50, longContext: 55, instruction: 70 },
      }),
      "provisional",
    );
  });

  test("getModelProfileConfidence classifies inherited family variants", () => {
    assert.equal(getModelProfileConfidence("gpt-5.4-preview"), "inherited");
    assert.equal(getModelProfileConfidence("claude-sonnet-5-beta"), "inherited");
  });

  test("auto-routing excludes unknown-confidence models when a profiled alternative exists", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      ["brand-new-unreleased-model", "claude-sonnet-4-6"],
      "execute-task",
    );

    assert.equal(result.modelId, "claude-sonnet-4-6");
    assert.equal(result.profileConfidence, "curated");
    assert.match(result.reason, /curated|capability/i);
  });

  test("scoreEligibleModels prefers curated confidence over cheaper unknowns", () => {
    const results = scoreEligibleModels(
      ["brand-new-unreleased-model", "claude-sonnet-4-6"],
      { reasoning: 1.0 },
    );

    assert.equal(results[0].modelId, "claude-sonnet-4-6");
    assert.equal(results[0].score >= results[1].score, true);
  });

  test("scoreEligibleModels uses provider-aware runtime costs when bare IDs collide across providers", () => {
    const results = scoreEligibleModels(
      ["openai/gpt-5.5", "github-copilot/gpt-5.5"],
      { reasoning: 1.0 },
      undefined,
      [
        {
          id: "gpt-5.5",
          provider: "openai",
          cost: { input: 6, output: 30, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: "gpt-5.5",
          provider: "github-copilot",
          cost: { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0 },
        },
      ] as unknown as Array<Model<Api>>,
    );

    assert.equal(results[0].modelId, "github-copilot/gpt-5.5");
  });

  test("resolveModelForComplexity fails closed when only unknown-profile candidates are available for automatic routing", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      ["brand-new-unreleased-model-a", "brand-new-unreleased-model-b"],
      "execute-task",
    );

    assert.equal(result.modelId, "claude-opus-4-6");
    assert.match(result.reason, /fail closed/i);
    assert.equal(result.rejected?.length, 2);
    assert.ok(result.rejected?.every((candidate) => /manual selection only, not auto-routed/i.test(candidate.reason)));
  });

  test("resolveModelForComplexity records concrete rejection reasons on the capability-scored path", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      ["brand-new-unreleased-model", "claude-sonnet-4-6", "gpt-4o"],
      "execute-task",
    );

    assert.equal(result.modelId, "claude-sonnet-4-6");
    assert.ok(result.rejected?.some((candidate) => candidate.modelId === "brand-new-unreleased-model" && /manual selection only, not auto-routed/i.test(candidate.reason)));
    assert.ok(result.rejected?.some((candidate) => candidate.modelId === "gpt-4o" && /capability|confidence|cost/i.test(candidate.reason)));
  });

  test("resolveModelForComplexity: STEP 3 automatic single-candidate fallback fails closed for an unknown-confidence model", () => {
    // capability_routing: false skips STEP 2 entirely, landing directly on
    // STEP 3's automatic single-eligible-model path with no capability profile.
    const config = { ...defaultRoutingConfig(), enabled: true, capability_routing: false };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      ["brand-new-unreleased-model-solo"],
      "execute-task",
    );

    assert.equal(result.modelId, "claude-opus-4-6", "must fail closed to configuredPrimary, not auto-select the unknown-confidence model");
    assert.match(result.reason, /fail closed/i);
    assert.equal(result.selectionMethod, "tier-only");
  });

  test("resolveModelForComplexity: STEP 3 skips a cheaper unknown-confidence model to find a known-confidence alternative", () => {
    // capability_routing: false skips STEP 2 entirely, landing on STEP 3's
    // automatic multi-candidate path. The unknown-confidence model is
    // deliberately cheaper (via runtime cost) so it sorts first in
    // getEligibleModels() — it must be skipped, not treated as a dead end
    // that masks the known-confidence "claude-sonnet-4-6" further down the
    // same eligible list.
    const config = { ...defaultRoutingConfig(), enabled: true, capability_routing: false };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      ["brand-new-unreleased-cheap-model", "claude-sonnet-4-6"],
      "execute-task",
      undefined,
      undefined,
      undefined,
      [
        {
          id: "brand-new-unreleased-cheap-model",
          cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0 },
        },
      ] as unknown as Array<Model<Api>>,
    );

    assert.equal(
      result.modelId,
      "claude-sonnet-4-6",
      "must skip the cheaper unknown-confidence model and select the known-confidence alternative",
    );
    assert.equal(result.selectionMethod, "tier-only");
  });

  test("resolveModelForComplexity: STEP 3 honors an explicit tier_models pin even without a capability profile", () => {
    const config: DynamicRoutingConfig = {
      ...defaultRoutingConfig(),
      enabled: true,
      capability_routing: false,
      tier_models: { standard: "brand-new-unreleased-model-pinned" },
    };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      ["brand-new-unreleased-model-pinned"],
      "execute-task",
    );

    assert.equal(result.modelId, "brand-new-unreleased-model-pinned", "an explicit tier_models pin must be honored even without a capability profile");
    assert.equal(result.selectionMethod, "tier-only");
  });
});
